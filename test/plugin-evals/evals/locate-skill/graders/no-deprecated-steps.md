---
type: llm
---

Tidewater 2.x releases follow lexica/skills/release.sdoc: freeze and branch, `make soak` on the reference host, bump `TIDEWATER_FORMAT_VERSION` if the on-disk format changed, write the changelog, tag with a signed tag (`git tag -s`), `make publish`, announce. A deprecated file, lexica/skills/release-v1.sdoc, describes the 1.x procedure, kept for the 1.9 maintenance branch only: `make stress`, an unsigned `git tag v1.9.N`, `make release`.

The question is about cutting 2.4.0.
PASS if every step the reply gives for 2.4.0 belongs to the 2.x procedure.
FAIL if it gives any step of the 1.x procedure (`make stress`, an unsigned tag, `make release`) as a step for 2.4.0, or mixes the two procedures. Mentioning the 1.x procedure as not applying is fine. Formatting does not matter.
