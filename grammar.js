/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * @file This is not the greatest language in the world, no. This is just a tribute.
 * @author Eunchong Yu <kroisse@gmail.com>
 * @license MIT
 */

// Use RustRegex for better Unicode support
// RustRegex uses Rust's regex crate syntax with Unicode property support
// See: https://docs.rs/regex/latest/regex/#syntax

// Helper: tagged template literal for RustRegex without double-escaping
// Usage: re`\d+` instead of new RustRegex('\\d+')
/**
 * @param {TemplateStringsArray} strings
 * @param {unknown[]} values
 * @returns {RustRegex}
 */
function re(strings, ...values) {
  let pattern = strings.raw[0];
  for (let i = 0; i < values.length; i++) {
    pattern += values[i] + strings.raw[i + 1];
  }
  return new RustRegex(pattern);
};

// Helper: common function signature parts (name, params, return type)
// Name can be identifier (add, len) or operator_name ((+), (<>))
const functionSignature = ($) => [
  $.keyword_fn,
  field("name", choice($.identifier, $.operator_name)),
  "(",
  optional(field("params", $.parameter_list)),
  ")",
  optional(field("return_type", $.return_type_annotation)),
];

export default grammar({
  name: "tribute",

  externals: ($) => [
    $.raw_string_literal,
    $.raw_bytes_literal,
    $.block_comment,
    $.block_doc_comment,
    $._multiline_string_start,
    $._multiline_string_content,
    $._multiline_string_end,
    $._multiline_bytes_start,
    $._multiline_bytes_content,
    $._multiline_bytes_end,
    $._raw_interpolated_string_start,
    $._raw_interpolated_string_content,
    $._raw_interpolated_string_end,
    $._raw_interpolated_bytes_start,
    $._raw_interpolated_bytes_content,
    $._raw_interpolated_bytes_end,
    $._newline, // Newline token for field separators (Go/Swift style)
    $._error_sentinel,
  ],

  conflicts: ($) => [[ $.constructor_expression ], [ $.case_arm ]],

  rules: {
    source_file: ($) => repeat($._item),

    _item: ($) =>
      choice(
        $.use_declaration,
        $.mod_declaration,
        $.function_definition,
        $.struct_declaration,
        $.enum_declaration,
        $.ability_declaration,
        $.const_declaration,
      ),

    // mod foo
    // mod Foo
    // mod foo { ... }
    // pub mod foo
    mod_declaration: ($) =>
      seq(
        optional($.visibility_marker),
        $.keyword_mod,
        field("name", $._name),
        optional(field("body", $.mod_body)),
      ),

    mod_body: ($) => seq("{", repeat($._item), "}"),

    // use std::io
    // use std::collections::List
    // use std::math::{sin, cos, tan}
    // use foo::bar as baz
    // use a::{b::{self, c as d}, e::f as g}
    // pub use internal::api
    use_declaration: ($) =>
      seq(
        optional($.visibility_marker),
        $.keyword_use,
        field("tree", $.use_tree),
      ),

    // Recursive use tree structure supporting:
    // - self, self as alias
    // - name, name as alias
    // - path::to::item, path::to::item as alias
    // - path::{nested, groups}
    use_tree: ($) =>
      choice(
        // self with optional alias: self, self as foo
        seq(
          alias("self", $.path_keyword),
          optional(seq($.keyword_as, field("alias", $._name))),
        ),
        // path-based trees
        seq(
          choice($._name, alias(choice("pkg", "super"), $.path_keyword)),
          optional(
            choice(
              // Just an alias: foo as bar
              seq($.keyword_as, field("alias", $._name)),
              // Continue with :: followed by more tree or group
              seq(
                "::",
                choice(
                  $.use_group,
                  $.use_tree,
                ),
              ),
            ),
          ),
        ),
      ),

    // Use group: {A, B::C, self as me, D as E}
    use_group: ($) =>
      seq("{", $.use_tree, repeat(seq(",", $.use_tree)), optional(","), "}"),

    // Path keywords for module-relative paths (used in expressions)
    path_keyword: ($) => choice("pkg", "super", "self"),

    // struct User { name: String, age: Nat }
    // struct Box(a) { value: a }
    // pub struct Point { x: Int, y: Int }
    struct_declaration: ($) =>
      seq(
        optional($.visibility_marker),
        $.keyword_struct,
        field("name", $.type_identifier),
        optional(field("type_params", $.type_parameters)),
        field("body", $.struct_body),
      ),

    type_parameters: ($) =>
      seq(
        "(",
        $.identifier,
        repeat(seq(",", $.identifier)),
        optional(","),
        ")",
      ),

    struct_body: ($) => seq("{", optional($.struct_fields), "}"),

    // Field separator: comma or newline (Go/Swift style)
    // NEWLINE is only emitted by scanner when followed by identifier (lookahead)
    _field_separator: ($) => choice(",", $._newline),

    struct_fields: ($) =>
      seq(
        $.struct_field,
        repeat(seq($._field_separator, $.struct_field)),
        optional(","),
      ),

    struct_field: ($) =>
      seq(field("name", $.identifier), ":", field("type", $._type)),

    // Type reference
    // Can be: String (type_identifier), a (type_variable), List(a) (generic_type),
    // fn(Int, Int) -> Int (function_type), #(Int, String) (tuple_type)
    _type: ($) =>
      choice($.type_identifier, $.type_variable, $.generic_type, $.function_type, $.tuple_type),

    // Tuple type: #(Int, String), #(a, b, c)
    tuple_type: ($) =>
      seq("#", "(", $._type, repeat(seq(",", $._type)), optional(","), ")"),

    // Function type: fn(Int, Int) -> Int, fn(a) ->{State(s)} b
    // - fn(Int) -> Int        : implicit effect polymorphic
    // - fn(Int) ->{} Int      : pure function (no effects)
    // - fn(Int) ->{State} Int : explicit effects
    function_type: ($) =>
      seq(
        $.keyword_fn,
        "(",
        optional(field("params", $.type_list)),
        ")",
        "->",
        optional(field("abilities", $.ability_row)),
        field("return_type", $._type),
      ),

    // Type list for function type parameters
    type_list: ($) => seq($._type, repeat(seq(",", $._type)), optional(",")),

    // Ability row: {}, {State(Int), Console}, {State(Int), e}
    // Empty row means pure function, non-empty lists abilities
    ability_row: ($) =>
      seq(
        "{",
        optional($.ability_list),
        "}",
      ),

    // List of abilities: State(Int), Console or State(Int), e
    ability_list: ($) =>
      seq(
        choice($.ability_item, $.ability_tail),
        repeat(seq(",", choice($.ability_item, $.ability_tail))),
        optional(","),
      ),

    // Ability item: Console, State(Int), Reader(String)
    ability_item: ($) =>
      seq($.type_identifier, optional($.type_arguments)),

    // Ability tail (row variable): e, rest
    ability_tail: ($) => $.type_variable,

    // Type arguments for generic types in abilities: (Int), (String, Bool)
    type_arguments: ($) =>
      seq("(", $._type, repeat(seq(",", $._type)), optional(","), ")"),

    // Type variables are lowercase: a, b, elem
    type_variable: ($) => $.identifier,

    // Generic type like List(a) or Option(String)
    generic_type: ($) =>
      prec(
        1,
        seq(
          $.type_identifier,
          "(",
          $._type,
          repeat(seq(",", $._type)),
          optional(","),
          ")",
        ),
      ),

    // Type names start with uppercase: User, String, List
    // Using RustRegex for future Unicode extensibility
    type_identifier: ($) => re`[A-Z][a-zA-Z0-9_]*`,

    // enum Option(a) { None, Some(a) }
    // enum Result(a, e) { Ok { value: a }, Err { error: e } }
    // pub enum Status { Active, Inactive }
    enum_declaration: ($) =>
      seq(
        optional($.visibility_marker),
        $.keyword_enum,
        field("name", $.type_identifier),
        optional(field("type_params", $.type_parameters)),
        field("body", $.enum_body),
      ),

    enum_body: ($) => seq("{", optional($.enum_variants), "}"),

    enum_variants: ($) =>
      seq(
        $.enum_variant,
        repeat(seq($._field_separator, $.enum_variant)),
        optional(","),
      ),

    // Variant: None, Some(a), Ok { value: a }
    enum_variant: ($) =>
      seq(
        field("name", $.type_identifier),
        optional(field("fields", $.variant_fields)),
      ),

    // Variant fields: tuple (a, b) or struct { name: Type }
    variant_fields: ($) => choice($.tuple_fields, $.struct_fields_block),

    // Tuple variant fields: (Int, String)
    tuple_fields: ($) =>
      seq("(", $._type, repeat(seq(",", $._type)), optional(","), ")"),

    // Struct variant fields: { name: Type, ... }
    struct_fields_block: ($) => seq("{", optional($.struct_fields), "}"),

    // ability Console {
    //     fn print(msg: String) -> Nil
    //     fn read() -> String
    // }
    // ability State(s) {
    //     op get() -> s
    //     op set(value: s) -> Nil
    // }
    // ability Fail {
    //     op fail(msg: Text) -> Never
    // }
    // pub ability Http { ... }
    ability_declaration: ($) =>
      seq(
        optional($.visibility_marker),
        $.keyword_ability,
        field("name", $.type_identifier),
        optional(field("type_params", $.type_parameters)),
        field("body", $.ability_body),
      ),

    ability_body: ($) => seq("{", repeat($.ability_operation), "}"),

    // fn print(msg: String) -> Nil   (tail-resumptive)
    // op get() -> s                   (general, explicit resume)
    ability_operation: ($) =>
      seq(
        field("kind", choice($.keyword_fn, $.keyword_op)),
        field("name", $.identifier),
        "(",
        optional($.typed_parameter_list),
        ")",
        "->",
        field("return_type", $._type),
      ),

    // (msg: String, value: Int)
    typed_parameter_list: ($) =>
      seq(
        $.typed_parameter,
        repeat(seq(",", $.typed_parameter)),
        optional(","),
      ),

    typed_parameter: ($) =>
      seq(field("name", $.identifier), ":", field("type", $._type)),

    // const MAX_SIZE = 1000
    // const PI: Float = 3.14159
    // pub const VERSION = "0.1.0"
    const_declaration: ($) =>
      seq(
        optional($.visibility_marker),
        $.keyword_const,
        field("name", $.identifier),
        optional(seq(":", field("type", $._type))),
        "=",
        field("value", $._expression),
      ),

    // fn add(x, y) { x + y }
    // fn add(x: Int, y: Int) -> Int { x + y }
    // fn add(x: a, y) -> a { x }  -- mixed typed/untyped
    // extern fn len(bytes: Bytes) -> Int  -- external implementation
    // pub extern "wasm" fn len(bytes: Bytes) -> Int  -- with ABI
    function_definition: ($) =>
      choice($.extern_function, $.regular_function),

    // extern fn: no body allowed
    extern_function: ($) =>
      seq(
        optional($.visibility_marker),
        $.extern_marker,
        ...functionSignature($),
      ),

    // regular fn: body required
    regular_function: ($) =>
      seq(
        optional($.visibility_marker),
        ...functionSignature($),
        field("body", $.block),
      ),

    // extern or extern "abi"
    extern_marker: ($) =>
      seq($.keyword_extern, optional(field("abi", $.string))),

    // Operator name for function definitions: (+), (<>), (==)
    operator_name: ($) => seq("(", $._operator, ")"),

    // -> Type or ->{E} Type
    return_type_annotation: ($) =>
      seq("->", optional(field("abilities", $.ability_row)), $._type),

    // Parameter with optional type annotation: x or x: Int
    parameter: ($) =>
      seq(
        field("name", $.identifier),
        optional(seq(":", field("type", $._type))),
      ),

    // Parameter list (requires at least one, can mix typed/untyped)
    parameter_list: ($) =>
      seq($.parameter, repeat(seq(",", $.parameter)), optional(",")),

    block: ($) =>
      seq("{", repeat(choice($.let_statement, $.expression_statement)), "}"),

    let_statement: ($) =>
      seq(
        $.keyword_let,
        field("pattern", $.pattern),
        "=",
        field("value", $._expression),
      ),

    expression_statement: ($) => $._expression,

    _expression: ($) =>
      choice(
        $.binary_expression,
        $.lambda_expression,
        $.constructor_expression,
        $.call_expression,
        $.resume_expression,
        $.method_call_expression,
        $.case_expression,
        $.handle_expression,
        $.record_expression,
        $.primary_expression,
      ),

    // resume value — only valid inside op handler arms
    resume_expression: ($) =>
      prec.right(
        0,
        seq(
          $.keyword_resume,
          optional(field("value", $._expression)),
        ),
      ),

    binary_expression: ($) => {
      const binop = (precedence, op) =>
        prec.left(
          precedence,
          seq(
            field("left", $._expression),
            field("operator", op),
            field("right", $._expression),
          ),
        );
      return choice(
        // Precedence (higher number = binds tighter)
        // 5: * / %
        binop(5, "*"),
        binop(5, "/"),
        binop(5, "%"),
        // 4: + - <>
        binop(4, "+"),
        binop(4, "-"),
        binop(4, "<>"),
        // 3: == != < > <= >=
        binop(3, "=="),
        binop(3, "!="),
        binop(3, "<"),
        binop(3, ">"),
        binop(3, "<="),
        binop(3, ">="),
        // 2: &&
        binop(2, "&&"),
        // 1: ||
        binop(1, "||"),
        // Qualified operators: a Int::+ b, xs List::<> ys
        binop(5, $.qualified_operator),
      );
    },

    call_expression: ($) =>
      prec(
        10,
        seq(
          field("function", choice($.identifier, $.path_expression)),
          "(",
          optional($.argument_list),
          ")",
        ),
      ),

    constructor_expression: ($) =>
      prec(
        10,
        seq(
          field("constructor", $.type_identifier),
          optional(seq("(", optional($.argument_list), ")")),
        ),
      ),

    // UFCS: x.f(y) -> f(x, y), x.f -> f(x), x.a::b(y) -> a::b(x, y)
    method_call_expression: ($) =>
      choice(
        // With arguments - higher priority to prefer this over no-args form
        prec.left(
          11,
          seq(
            field("receiver", $._expression),
            ".",
            field("method", $.method_path),
            "(",
            optional($.argument_list),
            ")",
          ),
        ),
        // Without arguments (getter style)
        prec.left(
          10,
          seq(
            field("receiver", $._expression),
            ".",
            field("method", $.method_path),
          ),
        ),
      ),

    case_expression: ($) =>
      seq(
        $.keyword_case,
        field("value", $._expression),
        "{",
        optional(
          seq(
            $.case_arm,
            repeat(seq($._field_separator, $.case_arm)),
            optional($._field_separator),
          ),
        ),
        "}",
      ),

    case_arm: ($) =>
      seq(
        field("pattern", $.pattern),
        choice(
          seq("->", field("value", $._expression)), // no guard
          seq(
            $.guarded_branch,
            repeat(seq($._newline, $.guarded_branch)),
          ), // with guards
        ),
      ),

    guarded_branch: ($) =>
      seq(
        $.keyword_if,
        field("guard", $._expression),
        "->",
        field("value", $._expression),
      ),

    // handle comp() {
    //     do result { result }
    //     fn Console::print(msg) { IO::write(stdout, msg) }
    //     op State::get() { run_state(fn() resume state, state) }
    //     op Fail::fail(msg) { None }
    // }
    handle_expression: ($) =>
      seq(
        $.keyword_handle,
        field("expr", $._expression),
        "{",
        optional(
          seq(
            $.handler_arm,
            repeat(seq($._field_separator, $.handler_arm)),
            optional($._field_separator),
          ),
        ),
        "}",
      ),

    // Handler arm: do x { body }, fn Op(args) { body }, op Op(args) { body }
    handler_arm: ($) =>
      choice(
        $.completion_handler,
        $.fn_handler,
        $.op_handler,
      ),

    // do result { body }
    completion_handler: ($) =>
      seq(
        $.keyword_do,
        field("binding", $.identifier),
        field("body", $.block),
      ),

    // fn Console::print(msg) { body }
    fn_handler: ($) =>
      seq(
        $.keyword_fn,
        field("operation", choice($.path_expression, $.identifier)),
        "(",
        optional(field("params", $.handler_parameter_list)),
        ")",
        field("body", $.block),
      ),

    // op State::get() { body }
    op_handler: ($) =>
      seq(
        $.keyword_op,
        field("operation", choice($.path_expression, $.identifier)),
        "(",
        optional(field("params", $.handler_parameter_list)),
        ")",
        field("body", $.block),
      ),

    // Handler parameters are just identifiers (patterns without types)
    handler_parameter_list: ($) =>
      seq($.identifier, repeat(seq(",", $.identifier)), optional(",")),

    // Handler pattern is now only used inside handle_expression, not general patterns
    pattern: ($) => choice($.simple_pattern, $.as_pattern),

    // Simple patterns (can be used in as_pattern without recursion)
    simple_pattern: ($) =>
      choice(
        $.literal_pattern,
        $.wildcard_pattern,
        $.constructor_pattern,
        $.tuple_pattern,
        $.list_pattern,
        $.identifier_pattern,
      ),

    literal_pattern: ($) =>
      choice(
        $.float_literal,
        $.int_literal,
        $.nat_literal,
        $.string,
        $.raw_string,
        $.raw_interpolated_string,
        $.bytes_string,
        $.raw_bytes,
        $.raw_interpolated_bytes,
        $.rune,
        $.keyword_true,
        $.keyword_false,
        $.keyword_nil,
      ),

    wildcard_pattern: ($) => "_",

    // Constructor pattern: None, Some(x), Pair(a, b), Ok { value: x }
    constructor_pattern: ($) =>
      seq(
        field("name", $.type_identifier),
        optional(
          choice(
            // Tuple-style: Some(x), Pair(a, b)
            seq("(", optional(field("args", $.pattern_list)), ")"),
            // Struct-style: Ok { value: x }
            seq("{", optional(field("fields", $.pattern_fields)), "}"),
          ),
        ),
      ),

    // Tuple pattern: #(a, b), #(x, y, z)
    tuple_pattern: ($) => seq("#", "(", field("elements", $.pattern_list), ")"),

    pattern_list: ($) =>
      seq($.pattern, repeat(seq(",", $.pattern)), optional(",")),

    pattern_fields: ($) =>
      seq(
        $.pattern_field,
        repeat(seq(",", $.pattern_field)),
        optional(seq(",", $.spread)), // trailing .. to ignore rest
        optional(","),
      ),

    // Spread operator: ..
    spread: ($) => "..",

    // Pattern field: name: pattern or just name (shorthand)
    pattern_field: ($) =>
      choice(
        // Full form: name: pattern
        seq(field("name", $.identifier), ":", field("pattern", $.pattern)),
        // Shorthand: name (binds to identifier with same name)
        field("name", $.identifier),
      ),

    identifier_pattern: ($) => $.identifier,

    // List pattern: [], [a, b, c], [head, ..tail], [first, ..]
    list_pattern: ($) =>
      seq(
        "[",
        optional(
          choice(
            // [a, b, c] or [head, ..tail] or [first, ..]
            seq(
              $.pattern,
              repeat(seq(",", $.pattern)),
              optional(seq(",", $.rest_pattern)),
              optional(","),
            ),
            // [..tail] - rest only
            $.rest_pattern,
          ),
        ),
        "]",
      ),

    // Rest pattern: ..tail or ..
    rest_pattern: ($) => seq($.spread, optional(field("name", $.identifier))),

    // As pattern: Some(x) as opt
    as_pattern: ($) =>
      prec.left(
        seq(
          field("pattern", $.simple_pattern),
          $.keyword_as,
          field("binding", $.identifier),
        ),
      ),

    argument_list: ($) => seq($._expression, repeat(seq(",", $._expression))),

    primary_expression: ($) =>
      choice(
        $.keyword_true,
        $.keyword_false,
        $.keyword_nil,
        $.float_literal,
        $.int_literal,
        $.nat_literal,
        $.string,
        $.raw_string,
        $.raw_interpolated_string,
        $.multiline_string,
        $.bytes_string,
        $.raw_bytes,
        $.raw_interpolated_bytes,
        $.multiline_bytes,
        $.rune,
        $.path_expression,
        $.identifier,
        $.list_expression,
        $.tuple_expression,
        $.operator_fn,
        $.block, // { expr } for grouping
      ),

    // All binary operators
    _operator: ($) =>
      choice(
        "+",
        "-",
        "*",
        "/",
        "%", // Arithmetic
        "<>",
        "==",
        "!=",
        "<=",
        ">=",
        "<",
        ">", // Comparison & concat
        "&&",
        "||", // Logical
      ),

    // Operator as function: (+), (<>), (==), (Int::+), (String::<>), etc.
    operator_fn: ($) =>
      seq(
        "(",
        field(
          "operator",
          choice(
            alias(
              token(
                choice(
                  "+",
                  "-",
                  "*",
                  "/",
                  "%",
                  "<>",
                  "==",
                  "!=",
                  "<=",
                  ">=",
                  "<",
                  ">",
                  "&&",
                  "||",
                ),
              ),
              $.operator,
            ),
            $.qualified_operator,
          ),
        ),
        ")",
      ),

    // Qualified operator: Int::+, List::<>, String::==
    // NOTE: This is a token to prevent partial matching (e.g., Foo:: without operator)
    // which would cause Foo::bar() to be parsed as binary_expression instead of call_expression
    qualified_operator: ($) =>
      token(
        seq(
          /[A-Z][a-zA-Z0-9_]*/,  // type_identifier pattern
          "::",
          choice("+", "-", "*", "/", "%", "<>", "==", "!=", "<=", ">=", "<", ">", "&&", "||"),
        ),
      ),

    // Record expression: User { name: "Alice", age: 30 }
    // Record with shorthand: User { name, age }
    // Record with spread: User { ..user, age: 31 }
    record_expression: ($) =>
      prec(
        11,
        seq(
          field("type", $.type_identifier),
          "{",
          optional(field("fields", $.record_fields)),
          "}",
        ),
      ),

    record_fields: ($) =>
      seq(
        $.record_field,
        repeat(seq($._field_separator, $.record_field)),
        optional($._field_separator),
      ),

    record_field: ($) =>
      choice(
        // Spread: ..expr
        seq($.spread, field("value", $._expression)),
        // Full form: name: value
        seq(field("name", $.identifier), ":", field("value", $._expression)),
        // Shorthand: name (binds to identifier with same name)
        field("name", $.identifier),
      ),

    // fn(x) x + 1
    // fn(x: Int) -> Int x + 1
    // fn(x, y) x + y
    // fn(x) { let y = x + 1; y * 2 }
    // Lowest precedence (0) so lambda body captures entire expression
    lambda_expression: ($) =>
      prec.right(
        0,
        seq(
          $.keyword_fn,
          "(",
          optional(field("params", $.parameter_list)),
          ")",
          optional(field("return_type", $.return_type_annotation)),
          field("body", $._expression),
        ),
      ),

    // Path expression: std::io, Int::to_string, Std::Collections::List
    // Also supports: pkg::module, super::item, self::helper
    // Keywords (True, False, Nil) won't match because identifier is lowercase-only
    // Note: path_segment wraps identifier/type_identifier due to tree-sitter lexer limitations
    path_expression: ($) =>
      prec.right(
        11,
        seq(
          choice(alias($._name, $.path_segment), $.path_keyword),
          repeat1(seq("::", alias($._name, $.path_segment))),
        ),
      ),

    // Method path for UFCS: double, math::double, Std::Collections::map
    // Must end with identifier (lowercase function name), not type_identifier
    method_path: ($) =>
      prec.right(
        11,
        seq(
          repeat(seq(alias($._name, $.path_segment), "::")),
          $.identifier,
        ),
      ),

    // [1, 2, 3]
    list_expression: ($) =>
      seq(
        "[",
        optional(
          seq(
            $._expression,
            repeat(seq(",", $._expression)),
            optional(","), // trailing comma
          ),
        ),
        "]",
      ),

    // #(1, "hello", 3.14) - at least one element required
    tuple_expression: ($) =>
      seq(
        "#",
        "(",
        $._expression,
        repeat(seq(",", $._expression)),
        optional(","), // trailing comma
        ")",
      ),

    // Number literals with type distinction
    // Nat: 0, 42, 0b1010, 0o777, 0xc0ffee (no sign)
    // Int: +1, -1, +0b1010, -0xff (explicit sign required)
    // Float: 1.0, +1.0, -3.14 (decimal point with digits required)
    nat_literal: ($) =>
      token(
        choice(
          re`[0-9]+`, // decimal: 0, 42
          re`0[bB][01]+`, // binary: 0b1010
          re`0[oO][0-7]+`, // octal: 0o777
          re`0[xX][0-9a-fA-F]+`, // hexadecimal: 0xc0ffee
        ),
      ),
    int_literal: ($) =>
      token(
        choice(
          re`[+-][0-9]+`, // decimal: +1, -1
          re`[+-]0[bB][01]+`, // binary: +0b1010, -0b1010
          re`[+-]0[oO][0-7]+`, // octal: +0o777, -0o777
          re`[+-]0[xX][0-9a-fA-F]+`, // hexadecimal: +0xff, -0xff
        ),
      ),
    float_literal: ($) => re`[+-]?[0-9]+\.[0-9]+`,

    // Rune literal: ?a, ?\n, ?\t, ?\x41, ?\u0041
    // Matches: ? followed by either:
    //   - A single printable character (not backslash or whitespace)
    //   - An escape sequence: \n, \r, \t, \0, \\, \xHH, \uHHHH
    rune: ($) =>
      token(
        choice(
          // Simple rune: ?a, ?Z, ?!, ?@, etc. (any printable non-backslash, non-whitespace)
          re`\?[^\\\s]`,
          // Escape sequences
          re`\?\\[nrt0\\]`, // ?\n, ?\r, ?\t, ?\0, ?\\
          re`\?\\x[0-9a-fA-F]{2}`, // ?\x41
          re`\?\\u[0-9a-fA-F]{4}`, // ?\u0041
        ),
      ),

    string: ($) =>
      seq(
        choice('"', 's"'),
        $.string_segment,
        optional(repeat1(seq($.interpolation, $.string_segment))),
        '"',
      ),

    string_segment: ($) =>
      prec(-1, re`([^"\\]|\\[nrtN0"\\]|\\x[0-9a-fA-F]{2})*`),

    interpolation: ($) =>
      seq("\\", "{", field("expression", $._expression), "}"),

    // Raw strings: r"...", r#"..."#, r##"..."##, etc.
    // Handled by external scanner for proper hash delimiter matching
    raw_string: ($) => $.raw_string_literal,

    // Raw interpolated strings: rs"...", sr"...", rs#"..."#, etc.
    // Handled by external scanner for proper hash delimiter matching
    raw_interpolated_string: ($) =>
      seq(
        $._raw_interpolated_string_start,
        $.raw_interpolated_string_segment,
        optional(
          repeat1(seq($.interpolation, $.raw_interpolated_string_segment)),
        ),
        $._raw_interpolated_string_end,
      ),

    raw_interpolated_string_segment: ($) => $._raw_interpolated_string_content,

    // Bytes string: b"..." with escape sequences and interpolation
    bytes_string: ($) =>
      seq(
        'b"',
        $.bytes_segment,
        optional(repeat1(seq($.bytes_interpolation, $.bytes_segment))),
        '"',
      ),

    bytes_segment: ($) => prec(-1, re`([^"\\]|\\[nrt0"\\]|\\x[0-9a-fA-F]{2})*`),

    bytes_interpolation: ($) =>
      seq("\\", "{", field("expression", $._expression), "}"),

    // Raw bytes: rb"...", rb#"..."#, etc.
    // Handled by external scanner for proper hash delimiter matching
    raw_bytes: ($) => $.raw_bytes_literal,

    // Raw interpolated bytes: rb"...", br"...", rb#"..."#, etc.
    // Handled by external scanner for proper hash delimiter matching
    raw_interpolated_bytes: ($) =>
      seq(
        $._raw_interpolated_bytes_start,
        $.raw_interpolated_bytes_segment,
        optional(
          repeat1(seq($.bytes_interpolation, $.raw_interpolated_bytes_segment)),
        ),
        $._raw_interpolated_bytes_end,
      ),

    raw_interpolated_bytes_segment: ($) => $._raw_interpolated_bytes_content,

    // Multiline strings: #"..."#, ##"..."##, etc.
    // Can span multiple lines, supports interpolation with \{expr}
    // Handled by external scanner for proper hash delimiter matching
    multiline_string: ($) =>
      seq(
        $._multiline_string_start,
        $.multiline_string_segment,
        optional(
          repeat1(seq($.multiline_interpolation, $.multiline_string_segment)),
        ),
        $._multiline_string_end,
      ),

    multiline_string_segment: ($) => $._multiline_string_content,

    multiline_interpolation: ($) =>
      seq("\\", "{", field("expression", $._expression), "}"),

    // Multiline bytes: b#"..."#, b##"..."##, etc.
    // Can span multiple lines, supports interpolation with \{expr}
    // Handled by external scanner for proper hash delimiter matching
    multiline_bytes: ($) =>
      seq(
        $._multiline_bytes_start,
        $.multiline_bytes_segment,
        optional(
          repeat1(
            seq($.multiline_bytes_interpolation, $.multiline_bytes_segment),
          ),
        ),
        $._multiline_bytes_end,
      ),

    multiline_bytes_segment: ($) => $._multiline_bytes_content,

    multiline_bytes_interpolation: ($) =>
      seq("\\", "{", field("expression", $._expression), "}"),

    // Identifiers start with lowercase letter or underscore (values, functions, constants)
    // Using RustRegex for future Unicode extensibility
    identifier: ($) => re`[a-z_][a-zA-Z0-9_]*`,

    // Name can be either identifier or type_identifier (used in paths, modules)
    _name: ($) => choice($.identifier, $.type_identifier),

    // Keywords
    keyword_fn: ($) => token(prec(2, "fn")),
    keyword_op: ($) => token(prec(2, "op")),
    keyword_do: ($) => token(prec(2, "do")),
    keyword_resume: ($) => token(prec(2, "resume")),
    keyword_let: ($) => "let",
    keyword_case: ($) => "case",
    keyword_struct: ($) => "struct",
    keyword_enum: ($) => "enum",
    keyword_ability: ($) => "ability",
    keyword_const: ($) => "const",
    keyword_pub: ($) => "pub",
    keyword_extern: ($) => "extern",

    // Visibility marker: pub, pub(pkg), pub(super)
    // Currently only supports 'pub', extensible for restricted visibility later
    visibility_marker: ($) =>
      seq(
        $.keyword_pub,
        optional(seq("(", choice("pkg", "super"), ")")),
      ),
    keyword_use: ($) => "use",
    keyword_mod: ($) => "mod",
    keyword_if: ($) => "if",
    keyword_handle: ($) => "handle",
    keyword_as: ($) => "as",
    keyword_true: ($) => token(prec(1, "True")),
    keyword_false: ($) => token(prec(1, "False")),
    keyword_nil: ($) => token(prec(1, "Nil")),

    // Comments
    // Line doc comment: /// ... (higher precedence to match before line_comment)
    line_doc_comment: ($) => token(prec(2, seq("///", re`.*`))),

    // Line comment: // ... (lower precedence, won't match /// due to doc comment)
    line_comment: ($) => token(prec(1, seq("//", re`.*`))),

    // block_comment and block_doc_comment are handled by external scanner
    // for proper nesting support: /* ... /* nested */ ... */
  },

  extras: ($) => [
    re`\s`, // Unicode-aware whitespace
    $.line_comment,
    $.line_doc_comment,
    $.block_comment,
    $.block_doc_comment,
  ],

  word: ($) => $.identifier,

  inline: ($) => [],
});
