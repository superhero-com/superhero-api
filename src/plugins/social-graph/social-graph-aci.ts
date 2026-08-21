import fs from 'fs';
import path from 'path';

const ACI_FILE_NAME = 'SocialContract.aci.json';

let cachedAci: any | null = null;

/**
 * Load the SocialContract ACI compiled from the pinned build (aesophia_http
 * v8.0.0, source commit recorded in the contract repo's deployments file). The
 * committed JSON is the exact ACI whose bytecode sha256 matches the recorded
 * deploy — reads and event decoding go through it, never an ad-hoc compile.
 *
 * Resolved by filesystem search (mirrors the address-links plugin) so it works
 * under ts-node, from `dist`, and from the repo root.
 */
export function loadSocialContractAci(): any {
  if (cachedAci) {
    return cachedAci;
  }
  const candidatePaths = [
    path.join(__dirname, 'aci', ACI_FILE_NAME),
    path.join(
      process.cwd(),
      'dist',
      'src',
      'plugins',
      'social-graph',
      'aci',
      ACI_FILE_NAME,
    ),
    path.join(
      process.cwd(),
      'dist',
      'plugins',
      'social-graph',
      'aci',
      ACI_FILE_NAME,
    ),
    path.join(
      process.cwd(),
      'src',
      'plugins',
      'social-graph',
      'aci',
      ACI_FILE_NAME,
    ),
  ];

  const existingPath = candidatePaths.find((candidatePath) =>
    fs.existsSync(candidatePath),
  );
  if (!existingPath) {
    throw new Error(
      `SocialContract ACI file not found. Searched: ${candidatePaths.join(', ')}`,
    );
  }

  cachedAci = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
  return cachedAci;
}
