# SEZU Native Operation Catalog

SEZU exposes exactly one MCP tool, `call_sezu`. The values below are operation names handled by that tool.

The catalog intentionally does not wrap every Linux command. Generic root work remains available through `sezu.exec`.

## Discovery

- `sezu.health`
- `sezu.version`
- `sezu.capabilities`

## Execution and jobs

- `sezu.exec`
- `sezu.job.start`
- `sezu.job.status`
- `sezu.job.output`
- `sezu.job.stdin`
- `sezu.job.signal`
- `sezu.job.pause`
- `sezu.job.resume`
- `sezu.job.cancel`
- `sezu.job.list`
- `sezu.job.delete`
- `sezu.job.wait`
- `sezu.job.group`

`sezu.job.group` supports explicit sequential, parallel, dependency, and multi-target fan-out execution.

## Processes and cgroups

- `sezu.process.list`
- `sezu.process.stat`
- `sezu.process.tree`
- `sezu.process.signal`
- `sezu.process.pause`
- `sezu.process.resume`
- `sezu.process.renice`
- `sezu.process.affinity`
- `sezu.process.cgroup`

## Terminals

- `sezu.terminal.list`
- `sezu.terminal.create`
- `sezu.terminal.open`
- `sezu.terminal.read`
- `sezu.terminal.write`
- `sezu.terminal.resize`
- `sezu.terminal.interrupt`
- `sezu.terminal.close`
- `sezu.terminal.delete`

Terminal names are arbitrary and may be associated with a workspace.

## Files, trees, archives, and sources

- `sezu.file.stat`
- `sezu.file.list`
- `sezu.file.read`
- `sezu.file.write`
- `sezu.file.mkdir`
- `sezu.file.copy`
- `sezu.file.move`
- `sezu.file.remove`
- `sezu.file.chmod`
- `sezu.file.chown`
- `sezu.file.link`
- `sezu.transfer.start`
- `sezu.transfer.status`
- `sezu.transfer.resume`
- `sezu.transfer.cancel`
- `sezu.archive.create`
- `sezu.archive.extract`
- `sezu.source.import`
- `sezu.source.export`

Transfers support files or directory trees between any SEZU targets and supported external source types without routing the complete payload through ChatGPT.

## Artifacts

- `sezu.artifact.begin`
- `sezu.artifact.upload`
- `sezu.artifact.finalize`
- `sezu.artifact.abort`
- `sezu.artifact.get`
- `sezu.artifact.read`
- `sezu.artifact.list`
- `sezu.artifact.copy`
- `sezu.artifact.delete`

## Workspaces

- `sezu.workspace.list`
- `sezu.workspace.open`
- `sezu.workspace.get`
- `sezu.workspace.set`
- `sezu.workspace.close`
- `sezu.workspace.delete`

## Skills

- `sezu.skill.list`
- `sezu.skill.inspect`
- `sezu.skill.install`
- `sezu.skill.remove`
- `sezu.skill.run`

## Macros

- `sezu.macro.list`
- `sezu.macro.inspect`
- `sezu.macro.run`

## Capability packs

- `sezu.pack.list`
- `sezu.pack.status`
- `sezu.pack.install`
- `sezu.pack.remove`

Packs install only from the committed release lock set.

## Browser profiles

- `sezu.browser.profile.list`
- `sezu.browser.profile.create`
- `sezu.browser.profile.get`
- `sezu.browser.profile.import`
- `sezu.browser.profile.export`
- `sezu.browser.profile.delete`
- `sezu.browser.open`
- `sezu.browser.run`
- `sezu.browser.close`

## Cells and virtual machines

- `sezu.cell.list`
- `sezu.cell.status`
- `sezu.cell.create`
- `sezu.cell.clone`
- `sezu.cell.copy`
- `sezu.cell.refresh`
- `sezu.cell.rebuild`
- `sezu.cell.rename`
- `sezu.cell.move`
- `sezu.cell.start`
- `sezu.cell.stop`
- `sezu.cell.restart`
- `sezu.cell.pause`
- `sezu.cell.resume`
- `sezu.cell.delete`
- `sezu.cell.console`
- `sezu.cell.exec`
- `sezu.cell.file.push`
- `sezu.cell.file.pull`
- `sezu.cell.backup.export`
- `sezu.cell.backup.import`
- `sezu.cell.migrate`

## Incus resources

- `sezu.incus.request`
- `sezu.incus.operation.wait`
- `sezu.incus.operation.cancel`
- `sezu.project.list`
- `sezu.project.create`
- `sezu.project.update`
- `sezu.project.delete`
- `sezu.profile.list`
- `sezu.profile.create`
- `sezu.profile.update`
- `sezu.profile.apply`
- `sezu.profile.delete`
- `sezu.remote.list`
- `sezu.remote.add`
- `sezu.remote.update`
- `sezu.remote.remove`
- `sezu.certificate.list`
- `sezu.certificate.add`
- `sezu.certificate.token`
- `sezu.certificate.remove`
- `sezu.storage.pool.list`
- `sezu.storage.pool.create`
- `sezu.storage.pool.update`
- `sezu.storage.pool.delete`
- `sezu.volume.list`
- `sezu.volume.create`
- `sezu.volume.attach`
- `sezu.volume.detach`
- `sezu.volume.copy`
- `sezu.volume.move`
- `sezu.volume.backup.export`
- `sezu.volume.backup.import`
- `sezu.volume.delete`
- `sezu.network.list`
- `sezu.network.create`
- `sezu.network.update`
- `sezu.network.delete`
- `sezu.network.forward.list`
- `sezu.network.forward.create`
- `sezu.network.forward.update`
- `sezu.network.forward.delete`
- `sezu.network.zone.list`
- `sezu.network.zone.create`
- `sezu.network.zone.record.set`
- `sezu.network.zone.record.delete`
- `sezu.network.zone.delete`
- `sezu.device.list`
- `sezu.device.attach`
- `sezu.device.update`
- `sezu.device.detach`
- `sezu.image.list`
- `sezu.image.import`
- `sezu.image.build`
- `sezu.image.status`
- `sezu.image.publish`
- `sezu.image.copy`
- `sezu.image.launch`
- `sezu.image.delete`
- `sezu.snapshot.create`
- `sezu.snapshot.list`
- `sezu.snapshot.restore`
- `sezu.snapshot.copy`
- `sezu.snapshot.delete`

## Templates and service cells

- `sezu.template.list`
- `sezu.template.inspect`
- `sezu.template.launch`
- `sezu.template.delete-instance`

Deleting a template-launched instance does not delete attached persistent volumes unless the request explicitly includes them.

## Scheduling and backup

- `sezu.timer.create`
- `sezu.timer.list`
- `sezu.timer.run`
- `sezu.timer.delete`
- `sezu.backup.run`
- `sezu.backup.restore`

No schedule or backup destination exists until the owner configures it.
