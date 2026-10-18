# Self-hosted compatibility patches

This branch preserves the SAP signing, authentication path normalization, bounded
transport recovery and download response recovery patches. See the relevant
source commits and regression tests for implementation details.

Images are built and signed by GitHub Actions from this branch. Deployment
inventory, hostnames, local paths and runtime credentials belong in private
operations records, not in this repository.
