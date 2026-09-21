#!/usr/bin/env python3
"""Offline safety checks for the manual Controller standby helper."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("controller_standby", ROOT / "scripts/controller_standby.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fail(message):
    raise AssertionError(message)


def expect_error(callback, fragment):
    try:
        callback()
    except (ValueError, OSError) as error:
        if fragment not in str(error):
            fail(f"expected {fragment!r}, got {error!r}")
    else:
        fail(f"expected error containing {fragment!r}")


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def make_backup(root):
    controller = "abcdef1234"
    files = {
        "dist/planet": "planet-copy\n",
        "one/identity.secret": "secret\n",
        "one/identity.public": controller + ":public\n",
        "one/planet": "planet\n",
        "one/controller.d/network/" + controller + "000001.json":
            json.dumps({"id": controller + "000001"}) + "\n",
        "config/session.secret": "session\n",
        "ztncui-state/passwd": "hash\n",
    }
    for name, value in files.items():
        write(root / name, value)
    sums = []
    for name in sorted(files):
        sums.append(hashlib.sha256((root / name).read_bytes()).hexdigest() + "  " + name)
    write(root / "SHA256SUMS", "\n".join(sums) + "\n")


def main():
    assert module.safe_path("/srv/zt-controller-standby") == Path("/srv/zt-controller-standby")
    expect_error(lambda: module.safe_path("/srv"), "Unsafe state directory")
    expect_error(lambda: module.safe_path("/tmp"), "Unsafe state directory")
    expect_error(lambda: module.safe_path("/etc/zerotier"), "System directory")

    with tempfile.TemporaryDirectory(prefix="controller-standby-test-") as temporary:
        backup = Path(temporary) / "backup"
        make_backup(backup)
        source, manifest_hash, metadata = module.verify_backup(backup)
        assert source == backup and len(manifest_hash) == 64 and metadata == {}

        write(backup / "unexpected", "do not accept\n")
        expect_error(lambda: module.verify_backup(backup), "unlisted")
        (backup / "unexpected").unlink()
        manifest = backup / "SHA256SUMS"
        manifest.write_text(manifest.read_text().replace("one/planet", "../escape"))
        expect_error(lambda: module.verify_backup(backup), "unsafe path")

        outside = Path(temporary) / "outside"
        outside.write_text("outside\n")
        link = backup / "one/link"
        link.symlink_to(outside)
        expect_error(lambda: module.verify_backup(backup), "symlinks")

    with tempfile.TemporaryDirectory(prefix="controller-install-test-") as temporary:
        root = Path(temporary)
        paths = {label: root / "snapshot" / label for label in module.LABELS}
        targets = {label: root / "target" / label for label in module.LABELS}
        for label in module.LABELS:
            write(paths[label] / "new", label + " staged\n")
            write(targets[label] / "old", label + " preserved\n")
        instance = SimpleNamespace(paths=targets, stopped=lambda: None)
        module.install_staged(instance, paths)
        for label in module.LABELS:
            assert (targets[label] / "new").read_text() == label + " staged\n"
            assert not (targets[label] / "old").exists()
            originals = list(targets[label].parent.glob(label + ".pre-standby-*"))
            assert len(originals) == 1
            assert (originals[0] / "old").read_text() == label + " preserved\n"
            assert (targets[label] / "new").stat().st_mode & 0o777 == 0o600

    # Staging has four mount swaps, not one filesystem-wide transaction.
    # A failed second swap must restore every original and retain partial
    # staged files separately for operator inspection.
    with tempfile.TemporaryDirectory(prefix="controller-rollback-test-") as temporary:
        root = Path(temporary)
        paths = {label: root / "snapshot" / label for label in module.LABELS}
        targets = {label: root / "target" / label for label in module.LABELS}
        for label in module.LABELS:
            write(paths[label] / "new", label + " staged\n")
            write(targets[label] / "old", label + " preserved\n")
        instance = SimpleNamespace(paths=targets, stopped=lambda: None)
        original_rename = Path.rename

        def fail_second_swap(path, target):
            if path.name.startswith(".one.standby-") and Path(target) == targets["one"]:
                raise OSError("injected mount swap failure")
            return original_rename(path, target)

        Path.rename = fail_second_swap
        try:
            expect_error(lambda: module.install_staged(instance, paths), "injected mount swap failure")
        finally:
            Path.rename = original_rename
        for label in module.LABELS:
            assert (targets[label] / "old").read_text() == label + " preserved\n"
            assert not (targets[label] / "new").exists()
        failed = list(targets["config"].parent.glob("config.failed-standby-*"))
        assert len(failed) == 1 and (failed[0] / "new").is_file()

    print("PASS: Controller standby validation, Python-compatible install, and partial-swap rollback")


if __name__ == "__main__":
    main()
