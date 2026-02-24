/**
 * Utility functions for parsing includes query parameter
 * Supports nested relations like "txs,txs.block,keyBlock"
 */

export interface IncludesTree {
  [key: string]: IncludesTree;
}

/**
 * Parses a comma-separated includes string into an array of relation paths
 * @param includesString - Comma-separated string like "txs,txs.block,keyBlock"
 * @returns Array of relation paths, e.g., [["txs"], ["txs", "block"], ["keyBlock"]]
 */
export function parseIncludes(includesString: string): string[][] {
  if (!includesString || !includesString.trim()) {
    return [];
  }

  return includesString
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) =>
      path
        .split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0),
    );
}

/**
 * Builds a tree structure from parsed includes
 * @param includes - Array of relation paths from parseIncludes
 * @returns Tree structure, e.g., { txs: { block: {} }, keyBlock: {} }
 */
export function buildIncludesTree(includes: string[][]): IncludesTree {
  const tree: IncludesTree = {};

  for (const path of includes) {
    let current = tree;
    for (const segment of path) {
      if (!current[segment]) {
        current[segment] = {};
      }
      current = current[segment];
    }
  }

  return tree;
}

/**
 * Converts includes string directly to tree structure
 * @param includesString - Comma-separated string like "txs,txs.block,keyBlock"
 * @returns Tree structure
 */
export function parseIncludesToTree(includesString: string): IncludesTree {
  const parsed = parseIncludes(includesString);
  return buildIncludesTree(parsed);
}
