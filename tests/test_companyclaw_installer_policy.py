"""CompanyClaw enterprise-safety guarantees for the installer.

Requirement V1.1 ruling on conflict 2 (普通员工安装与管理员权限) states:
  * 默认不新增 Windows Defender 排除项
  * 卸载时允许员工选择保留或清除个人配置与数据

These tests pin those two guarantees so a later change cannot silently restore
the upstream behaviour.
"""

import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deployer.windows_setup import WindowsSetup


class _Config:
    def __init__(self, values=None):
        self.values = values or {}

    def get(self, key, default=None):
        return self.values.get(key, default)


class _Log:
    def __init__(self):
        self.steps = []
        self.warnings = []
        self.infos = []

    def step(self, message):
        self.steps.append(message)

    def warn(self, message):
        self.warnings.append(message)

    def info(self, message):
        self.infos.append(message)


def _make_setup(**attrs):
    setup = WindowsSetup.__new__(WindowsSetup)
    setup.config = _Config()
    setup.log = _Log()
    setup.node_dir = Path("C:/Users/test/.openclaw-node")
    for key, value in attrs.items():
        setattr(setup, key, value)
    return setup


class DefenderExclusionPolicyTests(unittest.TestCase):
    """The installer must not widen the host's security posture by default."""

    def test_exclusions_are_disabled_by_default(self):
        setup = _make_setup()
        with unittest.mock.patch.object(
            WindowsSetup, "_add_defender_exclusions"
        ) as add_exclusions:
            result = setup.ensure_defender_exclusions()

        self.assertTrue(result)
        add_exclusions.assert_not_called()

    def test_default_run_records_no_exclusion_step(self):
        setup = _make_setup()
        with unittest.mock.patch.object(WindowsSetup, "_add_defender_exclusions"):
            setup.ensure_defender_exclusions()

        joined = " ".join(setup.log.steps).lower()
        self.assertNotIn("defender", joined)
        self.assertTrue(
            any("skip" in info.lower() or "disabl" in info.lower() for info in setup.log.infos),
            f"expected an explicit skip message, got {setup.log.infos}",
        )

    def test_exclusions_run_only_on_explicit_opt_in(self):
        # The marker-writing mechanics under opt-in are covered by
        # tests/test_windows_setup_upgrade.py. Here we assert the policy
        # decision itself, which is a pure function and therefore not
        # sensitive to this machine's install state.
        from deployer.windows_setup import _defender_exclusions_opted_in

        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(_defender_exclusions_opted_in())

        with unittest.mock.patch.dict(
            "os.environ", {"COMPANYCLAW_DEFENDER_EXCLUSIONS": "1"}, clear=True
        ):
            self.assertTrue(_defender_exclusions_opted_in())

        with unittest.mock.patch.dict(
            "os.environ", {"OPENCLAW_DEFENDER_EXCLUSIONS": "true"}, clear=True
        ):
            self.assertTrue(_defender_exclusions_opted_in())

    def test_opt_in_path_reaches_the_exclusion_helper_when_requested(self):
        # Marker mechanics under opt-in are covered by
        # tests/test_windows_setup_upgrade.py (updated for the opt-in gate).
        # Here we assert the observable contract: with the opt-in gate open and
        # no prior marker, the exclusion helper is invoked.
        setup = _make_setup()
        with tempfile.TemporaryDirectory() as tmp:
            isolated_root = Path(tmp)
            with unittest.mock.patch.object(
                WindowsSetup, "_add_defender_exclusions", return_value=True
            ) as add_exclusions:
                with unittest.mock.patch(
                    "deployer.windows_setup._defender_exclusions_opted_in", return_value=True
                ):
                    with unittest.mock.patch(
                        "deployer.windows_setup.DEFAULT_DESKTOP_DIR", isolated_root
                    ):
                        result = setup.ensure_defender_exclusions()

        self.assertTrue(result)
        add_exclusions.assert_called_once()

    def test_opt_in_accepts_only_explicit_truthy_values(self):
        for value in ("0", "false", "", "no"):
            with self.subTest(value=value):
                setup = _make_setup()
                with unittest.mock.patch.dict(
                    "os.environ", {"COMPANYCLAW_DEFENDER_EXCLUSIONS": value}, clear=False
                ):
                    with unittest.mock.patch.object(
                        WindowsSetup, "_add_defender_exclusions", return_value=True
                    ) as add_exclusions:
                        setup.ensure_defender_exclusions()
                add_exclusions.assert_not_called()


class UninstallDataRetentionTests(unittest.TestCase):
    """Uninstall must not destroy employee data without an explicit choice."""

    def _read_uninstall_script(self):
        script = Path(__file__).resolve().parent.parent / "scripts" / "windows"
        return (script / "uninstall-dependencies.ps1").read_text(encoding="utf-8")

    def test_openclaw_config_removal_is_guarded_by_a_switch(self):
        text = self._read_uninstall_script()
        self.assertIn(
            "$PurgeUserData",
            text,
            "the uninstaller must gate user-data removal behind a switch",
        )
        self.assertRegex(
            text,
            r"if\s*\(\$PurgeUserData\)",
            "user-data removal must be conditional",
        )

    def test_unconditional_deletion_is_gone(self):
        text = self._read_uninstall_script()
        # The only remaining Remove-Item on the OpenClaw config dir must sit
        # inside the $PurgeUserData branch.
        guard = text.index("if ($PurgeUserData)")
        removal = text.index('Remove-Item -Path $OpenClawDir')
        self.assertGreater(removal, guard)

    def test_default_invocation_preserves_user_data(self):
        text = self._read_uninstall_script()
        # The switch must default to false so an ordinary run keeps data.
        self.assertRegex(text, r"\[switch\]\$PurgeUserData\s*=\s*\$false")


if __name__ == "__main__":
    unittest.main()
