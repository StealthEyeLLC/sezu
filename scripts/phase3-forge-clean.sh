#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
systemctl stop docker.service containerd.service
rm -f /usr/sbin/policy-rc.d
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.npm /root/.local/share/Trash
find /root /home -maxdepth 2 -type f \( -name '.bash_history' -o -name '.python_history' -o -name '.lesshst' -o -name '.wget-hsts' \) -delete 2>/dev/null || true
docker_dir=/var/lib/docker
if test -d "$docker_dir"; then find "$docker_dir" -name '*sezu-phase3-test*' -delete 2>/dev/null || true; fi
cloud-init clean --logs
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id
truncate -s 0 /etc/machine-id
rm -rf /opt/sezu-build /var/lib/sezu-phase3
sync
