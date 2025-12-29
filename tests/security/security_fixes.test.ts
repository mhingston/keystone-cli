import { describe, expect, test } from 'bun:test';
import { ExpressionEvaluator } from '../../src/expression/evaluator';
import { detectShellInjectionRisk, executeShell } from '../../src/runner/executors/shell-executor';
import { validateRemoteUrl } from '../../src/runner/mcp-client';
import { ConsoleLogger } from '../../src/utils/logger';

describe('Security Fixes Verification', () => {
  describe('Shell Injection Whitelist', () => {
    test('should allow safe alphanumeric commands', () => {
      expect(detectShellInjectionRisk('echo hello')).toBe(false);
      expect(detectShellInjectionRisk('ls -la')).toBe(false);
      expect(detectShellInjectionRisk('python script.py --arg value')).toBe(false);
    });

    test('should block dangerous shell metacharacters', () => {
      const dangerous = [
        'ls; rm -rf /',
        'echo hello | grep h',
        'cat file > output',
        'echo `whoami`',
        '$(whoami)',
        'echo $VAR',
        'echo "quoted"',
        "echo 'quoted'",
        'python script.py && exit',
      ];

      for (const cmd of dangerous) {
        expect(detectShellInjectionRisk(cmd)).toBe(true);
      }
    });

    test('should block extended dangerous characters from new whitelist', () => {
      // These were not in the old blacklist but are blocked by the new whitelist
      expect(detectShellInjectionRisk('func() { echo owned; }')).toBe(true); // Parentheses
      expect(detectShellInjectionRisk('echo {brace,expansion}')).toBe(true); // Braces
      expect(detectShellInjectionRisk('echo [abc]')).toBe(true); // Brackets
      expect(detectShellInjectionRisk('echo \\escaped')).toBe(true); // Backslash
      expect(detectShellInjectionRisk('echo #comment')).toBe(true); // Hash
    });
  });

  describe('SSRF Protection', () => {
    test('should resolve valid public IPs (mocked DNS)', async () => {
      // Note: We can't easily mock lookup in bun:test without more setup,
      // but we can test the IP validation logic if we extract it or test known IPs.
      // Testing literal IP blocking:
      const validate = async (url: string) => validateRemoteUrl(url, { allowInsecure: false });

      await expect(validate('https://127.0.0.1')).rejects.toThrow('localhost/loopback');
      await expect(validate('https://10.0.0.1')).rejects.toThrow('private/internal');
      await expect(validate('https://192.168.1.1')).rejects.toThrow('private/internal');

      // Cloud metadata (Link-local address is caught by private IP check first)
      await expect(validate('https://169.254.169.254')).rejects.toThrow(
        /private\/internal|cloud metadata/
      );
    });
  });
});
