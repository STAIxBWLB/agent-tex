// The image each atex release pins (issue #2). `digest` is the published multi-arch index digest of
// `${repo}:${tag}`; the image workflow fails when it differs from the registry.
export const IMAGE = {
  repo: "ghcr.io/staixbwlb/agent-tex",
  tag: "2026.2",
  digest: "sha256:5ff4bdb27e976f81f0c6462e2cc1af28217cac8af5260152c53b3f13a49c5e30",
} as const;

export type ImagePin = { repo: string; tag: string; digest: string };

// The digest is the pin; an unpinned build only names the tag it would publish.
export function imageRef(image: ImagePin = IMAGE): string {
  return image.digest ? `${image.repo}@${image.digest}` : `${image.repo}:${image.tag}`;
}
