package tree_sitter_tribute_test

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"
	tree_sitter_tribute "github.com/kroisse/tree-sitter-tribute/bindings/go"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_tribute.Language())
	if language == nil {
		t.Errorf("Error loading Tribute grammar")
	}
}
