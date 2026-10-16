#!/usr/bin/env python3
"""Manual, fail-closed Controller standby operations; never elect or fence remotely."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
LABELS = {"dist": "/app/dist", "one": "/var/lib/zerotier-one",
          "config": "/app/config", "ztncui-state": "/var/lib/ztncui"}
GUARD = "controller-standby.json"
CAPABILITY = "io.ms-zerotier-planet.controller-standby"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(args, check=True):
    # Keep the host helper usable on the Python 3.6 shipped by some older
    # LTS images; ``text``/``capture_output`` and ``removeprefix`` are newer.
    result = subprocess.run(args, cwd=ROOT, universal_newlines=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if check:
        require(result.returncode == 0, "Command failed: " + " ".join(args[:3]) + " (output withheld)")
    return result


def digest(file):
    value = hashlib.sha256()
    with open(file, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_json(file):
    require(file.is_file() and not file.is_symlink(), "Missing or unsafe JSON file: " + str(file))
    require(file.stat().st_size <= 1024 * 1024, "JSON file is too large")
    return json.loads(file.read_text())


def write_json(file, value):
    require(not file.is_symlink(), "Refusing symlink: " + str(file))
    fd, name = tempfile.mkstemp(prefix=".standby-", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def overlap(a, b):
    return a == b or a in b.parents or b in a.parents


def safe_path(raw):
    path = Path(os.path.abspath(raw))
    require(path == path.resolve(), "Symlinked state paths are not allowed: " + str(path))
    forbidden = [Path(x) for x in ("/", "/home", "/root", "/var", "/var/lib", "/tmp", "/srv", "/data")]
    require(path not in forbidden and path != ROOT and path not in ROOT.parents,
            "Unsafe state directory: " + str(path))
    for prefix in ("/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/run", "/boot", "/var/lib/docker", "/var/lib/containerd"):
        base = Path(prefix)
        require(path != base and base not in path.parents, "System directory is not a state path")
    return path


def regular_tree(directory):
    require(directory.is_dir() and not directory.is_symlink(), "Missing/unsafe directory: " + str(directory))
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            item = Path(parent) / name
            mode = item.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), "Special files/symlinks are not accepted: " + str(item))


def verify_backup(source):
    """Validate every regular file, rejecting manifest traversal and unlisted data."""
    source = safe_path(source)
    regular_tree(source)
    manifest = source / "SHA256SUMS"
    require(manifest.is_file(), "Backup has no SHA256SUMS")
    recorded = {}
    for line in manifest.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        require(match, "Unsupported checksum manifest entry")
        relative_name = match[2]
        if relative_name.startswith("./"):
            relative_name = relative_name[2:]
        relative = Path(relative_name)
        require(not relative.is_absolute() and ".." not in relative.parts,
                "Checksum manifest contains an unsafe path")
        key = str(relative)
        require(key not in recorded and key != "SHA256SUMS", "Duplicate/self-referential manifest entry")
        file = source / relative
        require(file.is_file() and not file.is_symlink(), "Missing backup file: " + key)
        require(digest(file) == match[1], "Backup checksum mismatch: " + key)
        recorded[key] = match[1]
    actual = {str(item.relative_to(source)) for item in source.rglob("*") if item.is_file() and item != manifest}
    require(actual == set(recorded), "Backup contains unlisted or missing files")
    for label in LABELS:
        require((source / label).is_dir(), "Backup is missing " + label)
    for key in ("one/identity.secret", "one/identity.public", "one/planet", "ztncui-state/passwd", "config/session.secret"):
        require((source / key).is_file() and (source / key).stat().st_size, "Backup lacks required preserved state: " + key)
    require((source / "one/controller.d/network").is_dir(), "Backup lacks Controller networks")
    # New snapshots identify consistency explicitly; older snapshots require
    # a separate acknowledgement instead of silently claiming consistency.
    metadata = {}
    if (source / "manifest.env").is_file():
        for line in (source / "manifest.env").read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                metadata[key] = value
    return source, digest(manifest), metadata


class Instance:
    def __init__(self):
        self.config = json.loads(run(["docker", "compose", "config", "--format", "json"]).stdout)
        self.project_name = self.config.get("name")
        require(isinstance(self.project_name, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]*", self.project_name),
                "Compose project name is missing or unsafe")
        self.service = self.config["services"]["myztplanet"]
        env = self.service.get("environment", {})
        self.env = env
        # A standby is deliberately Controller-only.  Carrying a Root role
        # between hosts would also carry host-specific public endpoints and
        # can advertise an unreachable Root after takeover.  Root migration
        # must be completed in a signed Planet before staging a standby.
        self.controller_role = (str(env.get("CONTROLLER_ONLY", "0")) == "1" and
                                str(env.get("ROOT_ONLY", "0")) == "0" and
                                env.get("PLANET_MODE") == "external")
        require(self.service.get("network_mode") == "host", "Requires host networking")
        self.paths = {}
        for label, target in LABELS.items():
            mounts = [item for item in self.service.get("volumes", []) if item.get("target") == target]
            require(len(mounts) == 1 and mounts[0].get("type") == "bind", "Requires a single bind mount for " + label)
            self.paths[label] = safe_path(mounts[0]["source"])
        for label, path in self.paths.items():
            for other, candidate in self.paths.items():
                if label != other:
                    require(not overlap(path, candidate), "State mounts must not overlap")
        self.name = self.service.get("container_name", "myztplanet")
        self.image_ref = self.service["image"]
        image = json.loads(run(["docker", "image", "inspect", self.image_ref]).stdout)[0]
        require((image.get("Config", {}).get("Labels") or {}).get(CAPABILITY) == "1",
                "Image lacks Controller standby startup protection; build the updated image first")
        self.image = image["Id"]
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", self.image), "Unexpected image ID")
        self.guard_path = self.paths["config"] / GUARD

    def require_controller_role(self):
        require(self.controller_role,
                "Requires Controller-only standby: PLANET_MODE=external, ROOT_ONLY=0, CONTROLLER_ONLY=1")

    def container(self):
        # A failed inspect is not proof that a primary is stopped. First
        # distinguish absence from daemon/permission failures explicitly.
        names = run(["docker", "ps", "-a", "--format", "{{.Names}}"]).stdout.splitlines()
        if self.name not in names:
            return None
        data = json.loads(run(["docker", "inspect", self.name]).stdout)[0]
        labels = data.get("Config", {}).get("Labels") or {}
        require(labels.get("com.docker.compose.project") == self.project_name and
                labels.get("com.docker.compose.service") == "myztplanet",
                "Container is not the configured Compose project/service")
        mounts = {item.get("Destination"): item.get("Source") for item in data.get("Mounts", [])}
        for label, target in LABELS.items():
            require(mounts.get(target) == str(self.paths[label]), "Container name belongs to different state mounts")
        return data

    def require_container_guard_capability(self, data):
        """A persistent guard only works if the installed entrypoint honors it."""
        image_id = data.get("Image")
        require(isinstance(image_id, str) and image_id,
                "Target container has no inspectable image ID")
        images = json.loads(run(["docker", "image", "inspect", image_id]).stdout)
        require(len(images) == 1 and
                (images[0].get("Config", {}).get("Labels") or {}).get(CAPABILITY) == "1",
                "Target container image lacks standby startup protection; upgrade/isolate it before fence")

    def stopped(self):
        data = self.container()
        require(not data or (not data["State"].get("Running") and not data["State"].get("Restarting")),
                "Target Controller must already be stopped; stage/promote never stop an active primary")
        # Detect another local container mounting any of the Controller state
        # directories.  Sharing only ``config``/``ztncui-state`` can still
        # race an atomic stage/promote replacement even when identities differ.
        ids = run(["docker", "ps", "-q"]).stdout.split()
        if ids:
            for item in json.loads(run(["docker", "inspect", *ids]).stdout):
                for mount in item.get("Mounts", []):
                    if mount.get("Type") == "bind":
                        source = Path(mount["Source"]).resolve()
                        require(all(not overlap(source, path) for path in self.paths.values()),
                                "Another running container shares Controller state")

    def tool(self, entrypoint, mounts, args):
        command = ["docker", "run", "--rm", "--network", "none", "--entrypoint", entrypoint]
        for source, target in mounts:
            require("," not in str(source), "Comma in Docker mount path is unsupported")
            command += ["--mount", f"type=bind,src={source},dst={target},readonly"]
        return run(command + [self.image] + list(args)).stdout

    def check_state(self, paths):
        public = self.tool("zerotier-idtool", [(paths["one"], "/state")], ["getpublic", "/state/identity.secret"]).strip()
        require(public == (paths["one"] / "identity.public").read_text().strip(), "Controller key pair does not match")
        controller_id = public.split(":")[0]
        require(re.fullmatch(r"[0-9a-f]{10}", controller_id), "Invalid Controller identity")
        planet = paths["config"] / "planet"
        require(planet.is_file(), "Missing external config/planet")
        metadata = json.loads(self.tool("/usr/local/libexec/mkworld", [(planet, "/candidate")], ["--inspect", "/candidate"]))
        is_root = any(root["identity"].split(":")[0].lower() == controller_id.lower() for root in metadata["roots"])
        if self.controller_role:
            require(not is_root,
                    "Controller-only identity is still a Root; publish and verify a newer World removing its Root role first")
        # Controller-only standbys must never be listed as Roots.
        old = paths["one"] / "planet"
        if digest(old) != digest(planet):
            self.tool("/usr/local/libexec/mkworld", [(old, "/old"), (planet, "/new")], ["--verify-update", "/old", "/new"])
        networks = []
        network_dir = paths["one"] / "controller.d/network"
        for file in network_dir.glob("*.json"):
            require(re.fullmatch(controller_id + r"[0-9a-f]{6}\.json", file.name), "Network file belongs to a different Controller")
            value = read_json(file)
            require(value.get("id", value.get("nwid", file.stem)) == file.stem, "Network ID does not match filename")
            networks.append(file.stem)
        require(networks, "No Controller networks found in the staged snapshot")
        return {"controllerId": controller_id, "networkIds": sorted(networks), "worldId": metadata["id"],
                "worldTimestamp": metadata["timestamp"], "planetSha256": digest(planet)}

    def guard(self):
        data = read_json(self.guard_path)
        require(data.get("schema") == 1 and data.get("state") in ("staged", "active", "fenced"), "Invalid standby guard")
        require(data.get("role") == "controller-only", "Standby guard role is not controller-only")
        require(re.fullmatch(r"[0-9a-f]{10}", data.get("controllerId", "")), "Invalid guarded Controller ID")
        require(str(uuid.UUID(data.get("instanceId", ""))) == data["instanceId"], "Invalid standby instance ID")
        return data

    def verify(self):
        for path in self.paths.values():
            regular_tree(path)
        guard = self.guard()
        require(guard.get("imageId") == self.image,
                "Staged image differs from the current local image; restage the standby before promote")
        observed = self.check_state(self.paths)
        for key in ("controllerId", "planetSha256", "worldId", "worldTimestamp"):
            require(guard.get(key) == observed[key], "Staged state differs from recorded " + key)
        require(digest(self.paths["one"] / "identity.secret") == guard.get("identitySha256"), "Controller identity changed after staging")
        if guard["state"] != "active":
            require(tree_digest(self.paths) == guard.get("stateSha256"), "Staged files changed; restage a verified snapshot")
        return guard, observed


def tree_digest(paths):
    value = hashlib.sha256()
    for label, directory in sorted(paths.items()):
        for file in sorted(directory.rglob("*")):
            if file.is_file() and not (label == "config" and file.name in (GUARD, "controller-fence.json")):
                value.update((label + "/" + str(file.relative_to(directory)) + "\0" + digest(file) + "\n").encode())
    return value.hexdigest()


def stage(instance, args):
    require(args.yes, "stage requires --yes")
    instance.require_controller_role()
    instance.stopped()
    source, backup_hash, metadata = verify_backup(args.backup)
    consistency = metadata.get("consistency", "unknown")
    require(consistency == "offline" or args.accept_unverified_snapshot,
            "Snapshot consistency is online/unknown; take an offline backup or explicitly use --accept-unverified-snapshot")
    for target in instance.paths.values():
        require(not overlap(source, target), "Backup source overlaps target state")
    previous = instance.guard() if instance.guard_path.exists() else None
    if previous:
        require(previous["state"] in ("staged", "fenced"), "Cannot stage over an active Controller; fence it first")
    else:
        require(all(not path.exists() or not any(path.iterdir()) for path in instance.paths.values()),
                "New standby requires empty, dedicated mounts; never reuse an existing Root/client directory")
    # All work is first done in a private directory. Source is reverified
    # afterwards so a changing online snapshot is never silently accepted.
    with tempfile.TemporaryDirectory(prefix="controller-stage-") as temporary:
        snapshot = Path(temporary)
        paths = {}
        for label in LABELS:
            paths[label] = snapshot / label
            shutil.copytree(source / label, paths[label])
        if args.planet:
            raw_candidate = Path(args.planet)
            require(not raw_candidate.is_symlink(), "Candidate Planet symlinks are not accepted")
            candidate = raw_candidate.resolve(strict=True)
            require(candidate.is_file() and candidate.stat().st_nlink == 1,
                    "Candidate Planet must be a regular, non-symlink file with one link")
            shutil.copyfile(candidate, paths["config"] / "planet")
        elif not (paths["config"] / "planet").is_file():
            shutil.copyfile(paths["one"] / "planet", paths["config"] / "planet")
        # Keep network/controller data, auth tokens, World signer and Web state.
        for filename in (GUARD, "controller-fence.json"):
            stale = paths["config"] / filename
            if stale.exists() or stale.is_symlink():
                stale.unlink()
        moons = paths["one"] / "moons.d"
        if moons.exists() and any(moons.glob("*.moon")):
            retired = paths["one"] / "moons.d.retired" / uuid.uuid4().hex
            retired.parent.mkdir(exist_ok=True, mode=0o700)
            moons.rename(retired)
            moons.mkdir(mode=0o700)
        # Local TCP/UDP port is a per-host concern, unlike Controller identity.
        local_conf = paths["one"] / "local.conf"
        settings = read_json(local_conf) if local_conf.exists() else {}
        settings.setdefault("settings", {})["primaryPort"] = int(instance.service["environment"].get("ZT_PORT", 9994))
        write_json(local_conf, settings)
        observed = instance.check_state(paths)
        if previous:
            require(previous["controllerId"] == observed["controllerId"], "Cannot replace standby with a different Controller")
            require(observed["worldId"] == previous["worldId"] and observed["worldTimestamp"] >= previous["worldTimestamp"], "Refusing World rollback")
            if observed["planetSha256"] != previous["planetSha256"]:
                instance.tool("/usr/local/libexec/mkworld", [(instance.paths["config"] / "planet", "/old"),
                              (paths["config"] / "planet", "/new")], ["--verify-update", "/old", "/new"])
        record = {"schema": 1, "state": "staged", "role": "controller-only",
                  # Every staging operation gets a fresh generation.  This
                  # invalidates a fence receipt from an earlier replacement.
                  "instanceId": str(uuid.uuid4()),
                  **observed, "backupHash": backup_hash, "backupCreatedAt": metadata.get("created_at"),
                  "snapshotConsistency": consistency, "stagedAt": utc(), "imageId": instance.image,
                  "identitySha256": digest(paths["one"] / "identity.secret"), "stateSha256": tree_digest(paths)}
        write_json(paths["config"] / GUARD, record)
        require(verify_backup(source)[1] == backup_hash, "Source snapshot changed during staging")
        install_staged(instance, paths)
    print(json.dumps({**record, "message": "Staged and stopped; explicitly fence the previous primary before promote"}, indent=2))


def install_staged(instance, paths):
    staged, preserved, installed = {}, {}, []
    try:
        for label, target in instance.paths.items():
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # ``dirs_exist_ok`` was added in Python 3.8.  The host helper is
            # intentionally usable with Python 3.6, so remove the empty
            # mkdtemp directory and let copytree create the destination.
            slot = Path(tempfile.mkdtemp(prefix="." + target.name + ".standby-", dir=target.parent))
            slot.rmdir()
            staged[label] = slot
            shutil.copytree(paths[label], slot)
            for item in [slot, *slot.rglob("*")]:
                item.chmod(0o700 if item.is_dir() else 0o600)
        instance.stopped()
        # Block startup before replacing any other mount. Old directories are
        # retained, never erased; a partial operation stays fail-closed.
        for label in ("config", "one", "dist", "ztncui-state"):
            target = instance.paths[label]
            if target.exists():
                old = target.with_name(target.name + ".pre-standby-" + uuid.uuid4().hex)
                target.rename(old)
                preserved[label] = old
            staged[label].rename(target)
            installed.append(label)
    except Exception:
        # Preserve partial datasets and restore every swapped original.
        for label in reversed(installed):
            target = instance.paths[label]
            target.rename(target.with_name(target.name + ".failed-standby-" + uuid.uuid4().hex))
        for label, old in preserved.items():
            old.rename(instance.paths[label])
        raise
    finally:
        for slot in staged.values():
            if slot.exists():
                shutil.rmtree(slot)  # Only this operation's mkdtemp directories.
    if preserved:
        print("Preserved previous directories: " + ", ".join(str(path) for path in preserved.values()))


def fence(instance, args):
    require(args.yes, "fence requires --yes")
    instance.require_controller_role()
    target_id = str(uuid.UUID(args.target_instance))
    if instance.guard_path.exists():
        record = instance.guard()
        controller_id = record["controllerId"]
        require(record["instanceId"] != target_id, "Fence target cannot be the local instance")
    else:
        identity = instance.paths["one"] / "identity.public"
        require(identity.is_file(), "Controller identity is missing")
        controller_id = identity.read_text().strip().split(":", 1)[0]
        require(re.fullmatch(r"[0-9a-f]{10}", controller_id), "Invalid Controller identity")
        record = {"schema": 1, "instanceId": str(uuid.uuid4()), "controllerId": controller_id}
    container = instance.container()
    if container:
        instance.require_container_guard_capability(container)
    # Persist fence first; even a daemon restart must not reactivate it.
    observed = instance.check_state(instance.paths)
    record.update(state="fenced", role="controller-only", fencedAt=utc(), imageId=instance.image,
                  identitySha256=digest(instance.paths["one"] / "identity.secret"), **observed)
    write_json(instance.guard_path, record)
    if container:
        run(["docker", "update", "--restart=no", instance.name])
        run(["docker", "stop", "-t", "20", instance.name])
    instance.stopped()
    record["stateSha256"] = tree_digest(instance.paths)
    write_json(instance.guard_path, record)
    receipt = {"schema": 1, "state": "fenced", "controllerId": controller_id,
               "sourceInstanceId": record["instanceId"], "targetInstanceId": target_id, "fencedAt": record["fencedAt"]}
    write_json(instance.paths["config"] / "controller-fence.json", receipt)
    print(json.dumps(receipt, indent=2))
    print("Fence receipt: " + str(instance.paths["config"] / "controller-fence.json"))


def promote(instance, args):
    require(args.yes, "promote requires --yes")
    instance.require_controller_role()
    instance.stopped()
    record, observed = instance.verify()
    require(record["state"] in ("staged", "fenced"), "Instance is already marked active")
    if args.fence_receipt:
        receipt = read_json(Path(args.fence_receipt))
        require(receipt.get("schema") == 1 and receipt.get("state") == "fenced"
                and receipt.get("controllerId") == observed["controllerId"]
                and receipt.get("targetInstanceId") == record["instanceId"]
                and receipt.get("sourceInstanceId") != record["instanceId"], "Fence receipt does not authorize this standby")
        confirmation = {"kind": "trusted-fence-receipt", "sha256": digest(args.fence_receipt)}
    else:
        require(args.confirm_old_primary_fenced == observed["controllerId"] and args.reason and len(args.reason.strip()) >= 8,
                "Emergency promote requires --confirm-old-primary-fenced CONTROLLER_ID and --reason (at least 8 characters)")
        confirmation = {"kind": "operator-confirmed-external-fence", "reason": args.reason[:1000]}
    # Pin the tested local image ID using an ephemeral Compose override. No
    # pulling/building/tag races and no credential-bearing config dump.
    record.update(state="active", promotedAt=utc(), promotionEvidence=confirmation, imageId=instance.image)
    write_json(instance.guard_path, record)
    try:
        with tempfile.TemporaryDirectory(prefix="controller-promote-") as temporary:
            # Use the exact resolved Compose model that was inspected during
            # preflight.  This prevents COMPOSE_FILE/override drift between
            # validation and takeover while keeping all bind paths absolute.
            resolved = Path(temporary) / "resolved.json"
            write_json(resolved, instance.config)
            override = Path(temporary) / "override.json"
            write_json(override, {"services": {"myztplanet": {"image": instance.image, "restart": "unless-stopped"}}})
            run(["docker", "compose", "--project-directory", str(ROOT), "-f", str(resolved), "-f", str(override),
                 "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "myztplanet"])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            container = instance.container()
            state = container["State"] if container else {}
            if state.get("Running") and state.get("Health", {}).get("Status") == "healthy":
                print(json.dumps({"state": "active", **observed, "message": "Local service healthy; verify client authorization/traffic separately"}, indent=2))
                return
            require(state.get("Status") not in ("exited", "dead"), "Promoted Controller exited")
            time.sleep(2)
        raise ValueError("Promoted Controller did not become healthy")
    except BaseException:
        record.update(state="staged", promotionFailedAt=utc())
        write_json(instance.guard_path, record)
        # Do not enable an old primary or restore an old image automatically.
        run(["docker", "update", "--restart=no", instance.name], check=False)
        run(["docker", "stop", "-t", "20", instance.name], check=False)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    # argparse's subparser ``required=`` parameter is unavailable on Python
    # 3.6, which is still present on some supported hosts.
    commands = parser.add_subparsers(dest="command")
    staged = commands.add_parser("stage", help="Verify/copy a backup into a stopped, protected standby")
    staged.add_argument("backup")
    staged.add_argument("--planet", help="Verified newer non-Root Controller Planet (for initial role migration)")
    staged.add_argument("--accept-unverified-snapshot", action="store_true")
    staged.add_argument("--yes", action="store_true")
    commands.add_parser("verify")
    commands.add_parser("status")
    fenced = commands.add_parser("fence", help="Persist a local startup fence, stop this Controller, and issue a target-bound receipt")
    fenced.add_argument("--target-instance", required=True)
    fenced.add_argument("--yes", action="store_true")
    promoted = commands.add_parser("promote", help="Manual takeover; requires explicit trusted fencing evidence")
    evidence = promoted.add_mutually_exclusive_group(required=True)
    evidence.add_argument("--fence-receipt")
    evidence.add_argument("--confirm-old-primary-fenced")
    promoted.add_argument("--reason")
    promoted.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    if not args.command:
        parser.error("a command is required")
    os.umask(0o077)
    # Serialize operations for this checkout without deleting locks or state.
    # The lock is on this checkout's manage.sh inode; operators must still
    # serialize runs across separate checkouts/hosts themselves.
    with open(ROOT / "manage.sh", "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        instance = Instance()
        if args.command == "stage":
            stage(instance, args)
        elif args.command == "fence":
            fence(instance, args)
        elif args.command == "promote":
            promote(instance, args)
        elif args.command == "verify":
            guard, observed = instance.verify()
            print(json.dumps({**guard, **observed}, indent=2))
        else:
            record = instance.guard() if instance.guard_path.exists() else {"state": "unmanaged"}
            container = instance.container()
            print(json.dumps({**record, "container": instance.name,
                              "running": bool(container and container["State"].get("Running"))}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print("Controller standby error: " + str(error), file=sys.stderr)
        sys.exit(1)
