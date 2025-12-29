import { createHash } from 'node:crypto';
import type { Blueprint } from '../parser/schema';

export class BlueprintUtils {
  /**
   * Calculate a stable hash for a blueprint
   */
  static calculateHash(blueprint: Blueprint): string {
    const stableString = JSON.stringify(BlueprintUtils.sortObject(blueprint));
    return createHash('sha256').update(stableString).digest('hex');
  }

  /**
   * Recursively sort object keys for stable JSON stringification
   */
  private static sortObject(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      const sortedArray = obj.map((item) => BlueprintUtils.sortObject(item));
      // For stability, sort arrays of objects by a common key if possible,
      // otherwise sort by their stringified representation.
      return sortedArray.sort((a, b) => {
        const sA = JSON.stringify(a);
        const sB = JSON.stringify(b);
        return sA.localeCompare(sB);
      });
    }

    const sortedObj: Record<string, unknown> = {};
    const sortedKeys = Object.keys(obj as object).sort();
    for (const key of sortedKeys) {
      sortedObj[key] = BlueprintUtils.sortObject((obj as Record<string, unknown>)[key]);
    }
    return sortedObj;
  }

  /**
   * Detect drift between a blueprint and generated outputs
   * Returns a list of differences found.
   */
  static detectDrift(
    blueprint: Blueprint,
    generatedFiles: { path: string; purpose?: string }[]
  ): string[] {
    const diffs: string[] = [];
    const blueprintByPath = new Map(blueprint.files.map((file) => [file.path, file]));
    const generatedByPath = new Map(generatedFiles.map((file) => [file.path, file]));

    // Check for missing files
    for (const [filePath, blueprintFile] of blueprintByPath.entries()) {
      const generated = generatedByPath.get(filePath);
      if (!generated) {
        diffs.push(`Missing file: ${filePath}`);
      } else if (
        blueprintFile.purpose &&
        generated.purpose &&
        blueprintFile.purpose !== generated.purpose
      ) {
        // Optional: Check purpose drift if provided in outputs
        diffs.push(
          `Purpose drift in ${filePath}: expected "${blueprintFile.purpose}", got "${generated.purpose}"`
        );
      }
    }

    // Check for unexpected extra files
    for (const generated of generatedFiles) {
      if (!blueprintByPath.has(generated.path)) {
        diffs.push(`Extra file not in blueprint: ${generated.path}`);
      }
    }

    return diffs;
  }
}
