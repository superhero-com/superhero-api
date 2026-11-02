import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { SHORTS_RENDITION_POLICY_FINGERPRINT } from './shorts-rendition-policy';

type Program = 'ffmpeg' | 'ffprobe';
export interface ShortsEncodingRecipe {
  version: 1;
  policy: string;
  tools: Record<Program, string>;
  commands: { program: Program; args: string[] }[];
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Bind reported build/library versions without storing host paths in public metadata. */
export function encodingRecipe(
  versions: Record<Program, string>,
): ShortsEncodingRecipe {
  for (const program of ['ffmpeg', 'ffprobe'] as const) {
    if (
      !versions[program].startsWith(`${program} version `) ||
      Buffer.byteLength(versions[program]) > 65536 ||
      versions[program].includes('\0')
    )
      throw new Error('Invalid media toolchain identity');
  }
  return {
    version: 1,
    policy: SHORTS_RENDITION_POLICY_FINGERPRINT,
    tools: { ffmpeg: hash(versions.ffmpeg), ffprobe: hash(versions.ffprobe) },
    commands: [],
  };
}

/** Record the arguments actually executed, replacing only ephemeral file locations. */
export function recordEncodingCommand(
  recipe: ShortsEncodingRecipe,
  program: Program,
  args: readonly string[],
  original: string,
  directory: string,
) {
  recipe.commands.push({
    program,
    args: args.map((argument) => {
      if (argument === original) return '@original';
      if (argument.startsWith(directory + sep))
        return '@work/' + relative(directory, argument).split(sep).join('/');
      return argument;
    }),
  });
}

export function encodingFingerprint(recipe: ShortsEncodingRecipe) {
  return hash(
    JSON.stringify({
      version: recipe.version,
      policy: recipe.policy,
      tools: { ffmpeg: recipe.tools.ffmpeg, ffprobe: recipe.tools.ffprobe },
      commands: recipe.commands.map(({ program, args }) => ({ program, args })),
    }),
  );
}
