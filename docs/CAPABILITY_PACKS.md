# SEZU Capability Packs

Capability packs provide real abilities without forcing every large tool into the base `u` image. Every pack is locked in Phase 0. Installing a pack never resolves a moving version.

## Base packs installed in `u`

### `sezu-core`

Existing compiler, repository, container, VM, infrastructure, browser, document, media, transfer, and shell forge plus the SEZU skill/workspace/macro runtime.

### `data-core`

JupyterLab, Python kernel, NumPy, SciPy, pandas, Polars, scikit-learn, Arrow, Parquet, ORC, DuckDB, OpenCV, GDAL, and dbt Core.

Additional R, Julia, Deno, and .NET notebook kernels become available when their language pack is installed.

### `document-core`

Tesseract language core, OCRmyPDF, qpdf, Ghostscript, Poppler, Pandoc, LibreOffice, Typst, LaTeX core, Inkscape, Mermaid, PlantUML, Graphviz, ExifTool, SoX, and `yt-dlp`.

### `wasm-core`

Wasmtime, WIT/component tooling, Binaryen, Emscripten, and `wasm-pack`.

### `network-core`

mitmproxy, TShark, Scapy, HTTPie, `grpcurl`, `websocat`, `iperf3`, MQTT/AMQP/NATS clients, packet tools, and network-emulation utilities.

### `machine-image-core`

Packer plus the existing QEMU/KVM, cloud-init, OCI, archive, filesystem, and disk-image tooling.

### `cross-build-core`

ARM, AArch64, RISC-V, musl, MinGW, QEMU user emulation, multi-architecture OCI prerequisites, CMake toolchains, vcpkg, Conan, and Bazel.

## On-demand language packs

Each language is independent so a project installs only what it uses.

- `language-bun`
- `language-deno`
- `language-dotnet`
- `language-php`
- `language-kotlin`
- `language-julia`
- `language-r`
- `language-elixir-erlang`
- `language-lua`
- `language-dart`
- `language-powershell`
- `language-swift`
- `language-fortran`
- `language-haskell`
- `language-ocaml`
- `language-scala`
- `language-clojure`

## Other on-demand packs

### `data-spark`

Local Apache Spark and its notebook integration. It starts only when requested.

### `cad-3d`

OpenSCAD and headless Blender with common import/export tooling.

### `binary-firmware`

Ghidra, radare2, Binwalk, Volatility, Capstone, Keystone, Unicorn, angr, `rr`, enhanced GDB, libguestfs, and Sleuth Kit. Android-specific tools are deliberately absent.

### `cloud-aws`

AWS CLI and supporting session/plugin components.

### `cloud-azure`

Azure CLI.

### `cloud-gcp`

Google Cloud CLI and optional local emulators selected by the owner.

### `cloud-cloudflare`

Cloudflare Wrangler.

### `storage-extra`

MinIO client, Syncthing, SSHFS, SMB/NFS clients, `age`, `sops`, `gocryptfs`, DVC, and git-annex.

## Service templates

Service templates are not installed daemons in `u`. They launch isolated Incus cells only when requested.

- `service-postgresql`
- `service-mariadb`
- `service-redis`
- `service-mongodb`
- `service-clickhouse`
- `service-qdrant`
- `service-meilisearch`
- `service-opensearch`
- `service-rabbitmq`
- `service-nats`
- `service-redpanda`
- `service-minio`
- `service-oci-registry`
- `service-smtp-dev`
- `service-dns`
- `service-http`
- `service-reverse-proxy`

Each template defines image digest, instance type, ports, optional persistent volumes, and startup command. Nothing is published externally unless explicitly requested.

## Explicit omissions

No pack may install:

- a local LLM, embedding model, transcription model, reranker, or AI inference server;
- Android SDK, NDK, emulator, ADB, fastboot, APK tools, React Native Android, or Flutter Android support;
- an always-on dashboard, monitoring stack, database, broker, notebook, or cluster;
- an audit, evidence, report, policy, or approval subsystem.
