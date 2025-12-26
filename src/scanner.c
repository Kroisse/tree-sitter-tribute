#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

enum TokenType {
    // Raw string (no escape, no interpolation) - single token
    RAW_STRING_LITERAL,
    // Raw bytes (no escape, no interpolation) - single token
    RAW_BYTES_LITERAL,
    // Block comment with nesting support: /* ... /* nested */ ... */
    BLOCK_COMMENT,
    // Block doc comment with nesting support: /** ... */
    BLOCK_DOC_COMMENT,
    // Multiline string with interpolation: #"...\{expr}..."#
    MULTILINE_STRING_START,    // #"
    MULTILINE_STRING_CONTENT,  // text between interpolations
    MULTILINE_STRING_END,      // "#
    // Multiline bytes with interpolation: b#"...\{expr}..."#
    MULTILINE_BYTES_START,     // b#"
    MULTILINE_BYTES_CONTENT,   // text between interpolations
    MULTILINE_BYTES_END,       // "#
    // Raw interpolated string: rs"...\{expr}...", sr"...\{expr}..."
    RAW_INTERPOLATED_STRING_START,    // rs" or sr"
    RAW_INTERPOLATED_STRING_CONTENT,  // text between interpolations
    RAW_INTERPOLATED_STRING_END,      // " (with hashes)
    // Raw interpolated bytes: rb"...\{expr}...", br"...\{expr}..."
    RAW_INTERPOLATED_BYTES_START,     // rb" or br"
    RAW_INTERPOLATED_BYTES_CONTENT,   // text between interpolations
    RAW_INTERPOLATED_BYTES_END,       // " (with hashes)
    // Newline token for field separators (Go/Swift style)
    NEWLINE,

    ERROR_SENTINEL
};

typedef enum {
    MODE_NONE = 0,
    MODE_MULTILINE_STRING,
    MODE_MULTILINE_BYTES,
    MODE_RAW_INTERPOLATED_STRING,
    MODE_RAW_INTERPOLATED_BYTES,
} ScanMode;

// Scanner state for interpolated strings with hash delimiters
typedef struct {
    uint8_t opening_hash_count;
    ScanMode mode;
} Scanner;

void *tree_sitter_tribute_external_scanner_create(void) {
    return ts_calloc(1, sizeof(Scanner));
}

void tree_sitter_tribute_external_scanner_destroy(void *payload) {
    ts_free(payload);
}

unsigned tree_sitter_tribute_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    buffer[0] = (char)scanner->opening_hash_count;
    buffer[1] = (char)scanner->mode;
    return 2;
}

void tree_sitter_tribute_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner->opening_hash_count = 0;
    scanner->mode = MODE_NONE;
    if (length >= 2) {
        scanner->opening_hash_count = (uint8_t)buffer[0];
        scanner->mode = (ScanMode)buffer[1];
    }
}

static inline void advance(TSLexer *lexer) {
    lexer->advance(lexer, false);
}

static inline void skip(TSLexer *lexer) {
    lexer->advance(lexer, true);
}

static uint8_t count_hashes_up_to(TSLexer *lexer, uint8_t limit) {
    uint8_t count = 0;
    while (lexer->lookahead == '#' && count < limit) {
        advance(lexer);
        count++;
    }
    return count;
}

// Scan raw literal with hash delimiters
// Used for both raw strings (r"...", r#"..."#) and raw bytes (rb"...", rb#"..."#)
static bool scan_raw_literal(TSLexer *lexer, enum TokenType token_type) {
    // Count opening hashes
    uint8_t opening_hash_count = count_hashes_up_to(lexer, UINT8_MAX);

    // Must have opening quote
    if (lexer->lookahead != '"') {
        return false;
    }
    advance(lexer);

    // Scan content until we find closing quote + matching hashes
    for (;;) {
        if (lexer->eof(lexer)) {
            return false;
        }

        if (lexer->lookahead == '"') {
            advance(lexer);

            // Count closing hashes
            uint8_t closing_hash_count =
                count_hashes_up_to(lexer, opening_hash_count);

            // If we matched all hashes, we're done
            if (closing_hash_count == opening_hash_count) {
                lexer->result_symbol = token_type;
                lexer->mark_end(lexer);
                return true;
            }
            // Otherwise, the quote and hashes are part of the content, continue
        } else {
            advance(lexer);
        }
    }
}

static enum TokenType mode_content_token(ScanMode mode) {
    switch (mode) {
        case MODE_MULTILINE_STRING:
            return MULTILINE_STRING_CONTENT;
        case MODE_MULTILINE_BYTES:
            return MULTILINE_BYTES_CONTENT;
        case MODE_RAW_INTERPOLATED_STRING:
            return RAW_INTERPOLATED_STRING_CONTENT;
        case MODE_RAW_INTERPOLATED_BYTES:
            return RAW_INTERPOLATED_BYTES_CONTENT;
        case MODE_NONE:
        default:
            return ERROR_SENTINEL;
    }
}

static enum TokenType mode_end_token(ScanMode mode) {
    switch (mode) {
        case MODE_MULTILINE_STRING:
            return MULTILINE_STRING_END;
        case MODE_MULTILINE_BYTES:
            return MULTILINE_BYTES_END;
        case MODE_RAW_INTERPOLATED_STRING:
            return RAW_INTERPOLATED_STRING_END;
        case MODE_RAW_INTERPOLATED_BYTES:
            return RAW_INTERPOLATED_BYTES_END;
        case MODE_NONE:
        default:
            return ERROR_SENTINEL;
    }
}

static enum TokenType mode_start_token(ScanMode mode) {
    switch (mode) {
        case MODE_MULTILINE_STRING:
            return MULTILINE_STRING_START;
        case MODE_MULTILINE_BYTES:
            return MULTILINE_BYTES_START;
        case MODE_RAW_INTERPOLATED_STRING:
            return RAW_INTERPOLATED_STRING_START;
        case MODE_RAW_INTERPOLATED_BYTES:
            return RAW_INTERPOLATED_BYTES_START;
        case MODE_NONE:
        default:
            return ERROR_SENTINEL;
    }
}

// Scan interpolated content until interpolation or end delimiter
// Returns true if content was found (even empty content before \{ or end)
static bool scan_interpolated_content(TSLexer *lexer, Scanner *scanner, ScanMode mode) {
    uint8_t hash_count = scanner->opening_hash_count;
    enum TokenType content_token = mode_content_token(mode);
    bool has_content = false;

    for (;;) {
        if (lexer->eof(lexer)) {
            if (has_content) {
                lexer->result_symbol = content_token;
                lexer->mark_end(lexer);
                return true;
            }
            return false;
        }

        if (lexer->lookahead == '\\') {
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '{') {
                lexer->result_symbol = content_token;
                return true;
            }
            has_content = true;
            continue;
        }

        if (lexer->lookahead == '"') {
            lexer->mark_end(lexer);
            advance(lexer);

            uint8_t closing_hash_count = count_hashes_up_to(lexer, hash_count);

            if (closing_hash_count == hash_count) {
                lexer->result_symbol = content_token;
                return true;
            }
            has_content = true;
            continue;
        }

        advance(lexer);
        has_content = true;
        lexer->mark_end(lexer);
    }
}

// Scan interpolated end delimiter
static bool scan_interpolated_end(TSLexer *lexer, Scanner *scanner, ScanMode mode) {
    uint8_t hash_count = scanner->opening_hash_count;

    if (lexer->lookahead != '"') {
        return false;
    }
    advance(lexer);

    uint8_t closing_hash_count = count_hashes_up_to(lexer, hash_count);

    if (closing_hash_count == hash_count) {
        lexer->result_symbol = mode_end_token(mode);
        lexer->mark_end(lexer);
        scanner->opening_hash_count = 0;
        scanner->mode = MODE_NONE;
        return true;
    }

    return false;
}

// Scan interpolated start delimiter
static bool scan_interpolated_start(
    TSLexer *lexer,
    Scanner *scanner,
    ScanMode mode,
    uint8_t opening_hash_count
) {
    if (lexer->lookahead != '"') {
        return false;
    }

    advance(lexer);
    lexer->result_symbol = mode_start_token(mode);
    lexer->mark_end(lexer);
    scanner->opening_hash_count = opening_hash_count;
    scanner->mode = mode;
    return true;
}

// Scan block comment with nesting support
static bool scan_block_comment(TSLexer *lexer, bool is_doc_comment) {
    int nesting_depth = 1;

    while (nesting_depth > 0) {
        if (lexer->eof(lexer)) {
            return false;
        }

        if (lexer->lookahead == '/') {
            advance(lexer);
            if (lexer->lookahead == '*') {
                advance(lexer);
                nesting_depth++;
            }
        } else if (lexer->lookahead == '*') {
            advance(lexer);
            if (lexer->lookahead == '/') {
                advance(lexer);
                nesting_depth--;
            }
        } else {
            advance(lexer);
        }
    }

    lexer->result_symbol = is_doc_comment ? BLOCK_DOC_COMMENT : BLOCK_COMMENT;
    lexer->mark_end(lexer);
    return true;
}

bool tree_sitter_tribute_external_scanner_scan(
    void *payload,
    TSLexer *lexer,
    const bool *valid_symbols
) {
    Scanner *scanner = (Scanner *)payload;

    // Error recovery mode - bail out
    if (valid_symbols[ERROR_SENTINEL]) {
        return false;
    }

    // If we're inside an interpolated literal, handle content/end
    if (scanner->mode != MODE_NONE) {
        enum TokenType end_token = mode_end_token(scanner->mode);
        enum TokenType content_token = mode_content_token(scanner->mode);

        if (valid_symbols[end_token] && lexer->lookahead == '"') {
            if (scan_interpolated_end(lexer, scanner, scanner->mode)) {
                return true;
            }
        }
        if (valid_symbols[content_token]) {
            return scan_interpolated_content(lexer, scanner, scanner->mode);
        }
        return false;
    }

    // Handle whitespace
    // Skip spaces and tabs always
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        skip(lexer);
    }

    // If NEWLINE token is valid, emit it when the next token looks like a field or pattern.
    if (valid_symbols[NEWLINE] && (lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
        // Mark position before consuming newline
        lexer->mark_end(lexer);

        // Consume newline(s) and whitespace, treating CRLF as a single newline.
        while (lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
               lexer->lookahead == ' ' || lexer->lookahead == '\t') {
            if (lexer->lookahead == '\r') {
                advance(lexer);
                if (lexer->lookahead == '\n') {
                    advance(lexer);
                }
                continue;
            }
            if (lexer->lookahead == '\n') {
                advance(lexer);
                continue;
            }
            advance(lexer);
        }

        // Accept newline as separator if the next token can start an item/pattern.
        if ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
            (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
            (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
            lexer->lookahead == '_' ||
            lexer->lookahead == '-' ||
            lexer->lookahead == '"' ||
            lexer->lookahead == '\'' ||
            lexer->lookahead == '[' ||
            lexer->lookahead == '{' ||
            lexer->lookahead == '(' ||
            lexer->lookahead == '#') {
            lexer->result_symbol = NEWLINE;
            lexer->mark_end(lexer);
            return true;
        }
        // Not followed by an item/pattern start - don't emit NEWLINE.
    }

    // Otherwise skip newlines as normal whitespace
    while (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
        skip(lexer);
    }
    // Skip any remaining spaces/tabs after newlines
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        skip(lexer);
    }

    if (lexer->lookahead == 'b' &&
        (valid_symbols[MULTILINE_BYTES_START] ||
         valid_symbols[RAW_BYTES_LITERAL] ||
         valid_symbols[RAW_INTERPOLATED_BYTES_START])) {
        lexer->mark_end(lexer);
        advance(lexer);

        if (lexer->lookahead == '#' && valid_symbols[MULTILINE_BYTES_START]) {
            uint8_t hash_count = count_hashes_up_to(lexer, UINT8_MAX);

            if (lexer->lookahead == '"') {
                return scan_interpolated_start(lexer, scanner, MODE_MULTILINE_BYTES, hash_count);
            }
            return false;
        }

        if (lexer->lookahead == 'r' &&
            (valid_symbols[RAW_BYTES_LITERAL] || valid_symbols[RAW_INTERPOLATED_BYTES_START])) {
            advance(lexer);
            if (lexer->lookahead == '#' || lexer->lookahead == '"') {
                if (valid_symbols[RAW_INTERPOLATED_BYTES_START]) {
                    uint8_t hash_count = count_hashes_up_to(lexer, UINT8_MAX);
                    return scan_interpolated_start(
                        lexer,
                        scanner,
                        MODE_RAW_INTERPOLATED_BYTES,
                        hash_count
                    );
                }
                if (valid_symbols[RAW_BYTES_LITERAL]) {
                    return scan_raw_literal(lexer, RAW_BYTES_LITERAL);
                }
            }
            return false;
        }

        return false;
    }

    // Raw strings/bytes: r"...", r#"..."#, rb"...", rb#"..."#, rs"...", sr"..."
    if (lexer->lookahead == 'r' &&
        (valid_symbols[RAW_STRING_LITERAL] ||
         valid_symbols[RAW_BYTES_LITERAL] ||
         valid_symbols[RAW_INTERPOLATED_STRING_START] ||
         valid_symbols[RAW_INTERPOLATED_BYTES_START])) {
        lexer->mark_end(lexer);
        advance(lexer);

        if (lexer->lookahead == 's' && valid_symbols[RAW_INTERPOLATED_STRING_START]) {
            advance(lexer);
            if (lexer->lookahead == '#' || lexer->lookahead == '"') {
                uint8_t hash_count = count_hashes_up_to(lexer, UINT8_MAX);
                return scan_interpolated_start(
                    lexer,
                    scanner,
                    MODE_RAW_INTERPOLATED_STRING,
                    hash_count
                );
            }
        }

        if (lexer->lookahead == 'b' &&
            (valid_symbols[RAW_BYTES_LITERAL] || valid_symbols[RAW_INTERPOLATED_BYTES_START])) {
            advance(lexer);
            if (lexer->lookahead == '#' || lexer->lookahead == '"') {
                if (valid_symbols[RAW_INTERPOLATED_BYTES_START]) {
                    uint8_t hash_count = count_hashes_up_to(lexer, UINT8_MAX);
                    return scan_interpolated_start(
                        lexer,
                        scanner,
                        MODE_RAW_INTERPOLATED_BYTES,
                        hash_count
                    );
                }
                if (valid_symbols[RAW_BYTES_LITERAL]) {
                    return scan_raw_literal(lexer, RAW_BYTES_LITERAL);
                }
            }
        }

        if (valid_symbols[RAW_STRING_LITERAL]) {
            if (lexer->lookahead == '#' || lexer->lookahead == '"') {
                return scan_raw_literal(lexer, RAW_STRING_LITERAL);
            }
        }

        return false;
    }

    if (lexer->lookahead == 's' &&
        (valid_symbols[RAW_INTERPOLATED_STRING_START] || valid_symbols[MULTILINE_STRING_START])) {
        lexer->mark_end(lexer);
        advance(lexer);

        if (lexer->lookahead == 'r' && valid_symbols[RAW_INTERPOLATED_STRING_START]) {
            advance(lexer);
            if (lexer->lookahead == '#' || lexer->lookahead == '"') {
                uint8_t hash_count = 0;
                while (lexer->lookahead == '#') {
                    advance(lexer);
                    hash_count++;
                }
                return scan_interpolated_start(
                    lexer,
                    scanner,
                    MODE_RAW_INTERPOLATED_STRING,
                    hash_count
                );
            }
        }

        if (lexer->lookahead == '#' && valid_symbols[MULTILINE_STRING_START]) {
            uint8_t hash_count = count_hashes_up_to(lexer, UINT8_MAX);

            if (lexer->lookahead == '"') {
                return scan_interpolated_start(lexer, scanner, MODE_MULTILINE_STRING, hash_count);
            }
        }

        return false;
    }

    // Multiline string start: #"
    if (lexer->lookahead == '#' && valid_symbols[MULTILINE_STRING_START]) {
        lexer->mark_end(lexer);

        uint8_t hash_count = count_hashes_up_to(lexer, UINT8_MAX);

        if (lexer->lookahead == '"') {
            return scan_interpolated_start(lexer, scanner, MODE_MULTILINE_STRING, hash_count);
        }
    }

    // Block comments: /* ... */ or /** ... */
    if (lexer->lookahead == '/' &&
        (valid_symbols[BLOCK_COMMENT] || valid_symbols[BLOCK_DOC_COMMENT])) {
        lexer->mark_end(lexer);
        advance(lexer);

        if (lexer->lookahead == '*') {
            advance(lexer);

            if (lexer->lookahead == '*' && valid_symbols[BLOCK_DOC_COMMENT]) {
                advance(lexer);
                if (lexer->lookahead == '/') {
                    advance(lexer);
                    lexer->result_symbol = BLOCK_COMMENT;
                    lexer->mark_end(lexer);
                    return true;
                }
                return scan_block_comment(lexer, true);
            }

            if (valid_symbols[BLOCK_COMMENT]) {
                return scan_block_comment(lexer, false);
            }
        }
    }

    return false;
}
