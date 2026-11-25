// The image each atex release pins (issue #2). `digest` is the published multi-arch index digest of
// `${repo}:${tag}`; the image workflow fails when it differs from the registry.
export const IMAGE = {
  repo: "ghcr.io/staixbwlb/agent-tex",
  tag: "2026.1",
  digest: "sha256:bd9273f6214afb77a1521e0fa90e6a75b23eb555b3923e149e1f5c118f6af906",
} as const;

export type ImagePin = { repo: string; tag: string; digest: string };

// The digest is the pin; an unpinned build only names the tag it would publish.
export function imageRef(image: ImagePin = IMAGE): string {
  return image.digest ? `${image.repo}@${image.digest}` : `${image.repo}:${image.tag}`;
}
