# Disposable CI object storage

The upstream MinIO image and binary download are no longer accessible. The CI
overlay builds upstream release `RELEASE.2025-04-22T22-12-26Z` from its exact
commit `0d7408fc9969caf07de6a8c3a84f9fbb10a6739e`, using digest-pinned official
Go and Alpine base images. It preserves upstream source and licenses and uses
the upstream build flags. It does not substitute a different S3 implementation.

The normal Compose file and adopted daily containers retain their existing image
identity. The overlay is for disposable GitHub Actions databases and objects.
CI still requires infrastructure health and the real storage integration tests.

Sources:

- [Upstream release source](https://github.com/minio/minio/tree/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e)
- [Upstream build command](https://github.com/minio/minio/blob/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e/Makefile)
- [IBM advisory confirming image removal](https://www.ibm.com/support/pages/node/7289585)
