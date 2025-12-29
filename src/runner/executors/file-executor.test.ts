import { describe, expect, it } from 'bun:test';
import { type SearchReplaceBlock, applySearchReplaceBlocks } from './file-executor.ts';

describe('file-executor', () => {
  describe('applySearchReplaceBlocks', () => {
    it('should replace a unique search block', () => {
      const content = 'line1\nline2\nline3';
      const blocks: SearchReplaceBlock[] = [{ search: 'line2', replace: 'modified' }];
      const result = applySearchReplaceBlocks(content, blocks);
      expect(result).toBe('line1\nmodified\nline3');
    });

    it('should throw error if search block not found', () => {
      const content = 'line1\nline2\nline3';
      const blocks: SearchReplaceBlock[] = [{ search: 'missing', replace: 'modified' }];
      expect(() => applySearchReplaceBlocks(content, blocks)).toThrow(/Search block not found/);
    });

    it('should throw error if search block found multiple times', () => {
      const content = 'line1\nrepeat\nline3\nrepeat\nline4';
      const blocks: SearchReplaceBlock[] = [{ search: 'repeat', replace: 'modified' }];
      expect(() => applySearchReplaceBlocks(content, blocks)).toThrow(
        /Search block matched 2 times/
      );
    });

    it('should handle special characters in search block', () => {
      const content = 'function() { return 1; }';
      const blocks: SearchReplaceBlock[] = [{ search: 'return 1;', replace: 'return 2;' }];
      const result = applySearchReplaceBlocks(content, blocks);
      expect(result).toBe('function() { return 2; }');
    });

    it('should handle whitespace sensitivity', () => {
      const content = '  indent';
      const blocks: SearchReplaceBlock[] = [
        { search: ' indent', replace: 'dedent' }, // one space vs two
      ];
      // Should not find ' indent' because actual is '  indent' (double space) if strict?
      // Actually '  indent'.split(' indent') -> [' ', ''] -> found once!
      // Wait '  indent'.includes(' indent') is true.
      // '  indent'.split(' indent') -> [' ', ''] (length 2).
      // So it works.
      const result = applySearchReplaceBlocks(content, blocks);
      expect(result).toBe(' dedent');
    });
  });
});
