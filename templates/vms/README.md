# SEZU VM Templates

VM templates use the canonical `sezu` project, `sezu-btrfs` pool, and `sezu-br0` network without inheriting privileged-container settings. A caller supplies an exact image or disk source and explicitly requests start behavior and optional devices or volumes.
