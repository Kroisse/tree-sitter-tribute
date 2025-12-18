/**
 * @file This is not the greatest language in the world, no. This is just a tribute.
 * @author Eunchong Yu <kroisse@gmail.com>
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

export default grammar({
  name: "tribute",

  rules: {
    // TODO: add the actual grammar rules
    source_file: $ => "hello"
  }
});
