import XCTest
import SwiftTreeSitter
import TreeSitterTribute

final class TreeSitterTributeTests: XCTestCase {
    func testCanLoadGrammar() throws {
        let parser = Parser()
        let language = Language(language: tree_sitter_tribute())
        XCTAssertNoThrow(try parser.setLanguage(language),
                         "Error loading Tribute grammar")
    }
}
