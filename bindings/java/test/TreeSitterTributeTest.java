import io.github.treesitter.jtreesitter.Language;
import io.github.treesitter.jtreesitter.tribute.TreeSitterTribute;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

public class TreeSitterTributeTest {
    @Test
    public void testCanLoadLanguage() {
        assertDoesNotThrow(() -> new Language(TreeSitterTribute.language()));
    }
}
