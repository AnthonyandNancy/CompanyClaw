"""CompanyClaw per-user requirement for the Node.js runtime.

Requirement V1.1 (conflict 2) requires that everyday use must not depend on
administrator rights, and that where a dependency genuinely needs admin the
installer must offer an IT pre-deployment path or an alternative instead of
silently elevating.

The upstream Node.js Windows MSI is genuinely per-machine: upstream's own code
records that ``MSIINSTALLPERUSER=1`` fails with exit code 1603. So the correct
behaviour is not "pretend it is per-user" but "reuse any supported per-user
runtime first, and only fall back to the machine-wide MSI when nothing suitable
exists".
"""

import os
import unittest
import unittest.mock
from pathlib import Path

from deployer import windows_setup
from deployer.windows_setup import WindowsSetup


class PerUserNodePreferenceTests(unittest.TestCase):
    """The user-writable runtime must be the default preference."""

    def test_default_node_dir_is_user_writable(self):
        """The module-level default must live somewhere the user can write.

        A machine-wide default would force elevation on a locked-down machine,
        so the default is asserted directly on the shipped constant rather than
        by reloading the module (which would disturb other tests' imports).
        """
        default = str(windows_setup.DEFAULT_NODE_DIR).lower()
        self.assertTrue(
            "program files" not in default,
            f"default Node dir must not require admin, got {default}",
        )

    def test_standard_dirs_include_a_per_user_location(self):
        # Recognising a per-user runtime lets an IT pre-deployed install be
        # reused instead of triggering an elevated MSI run.
        per_user = [
            d for d in windows_setup._STANDARD_NODE_DIRS if "program files" not in str(d).lower()
        ]
        self.assertTrue(per_user, "no per-user standard Node location is recognised")

    def test_node_dir_can_be_overridden_for_it_predeployment(self):
        source = Path(windows_setup.__file__).read_text(encoding="utf-8")
        self.assertIn("OPENCLAW_NODE_DIR", source)
        # An IT pre-deployed or machine-wide runtime must be selectable without
        # editing code.
        self.assertRegex(source, r"DEFAULT_NODE_DIR\s*=\s*Path\(\s*os\.environ\.get\(", )

    def test_install_node_windows_is_not_advertised_as_per_user(self):
        """The docstring must not claim a per-user install the MSI cannot do."""
        doc = (WindowsSetup.install_node_windows.__doc__ or "").lower()
        self.assertNotIn(
            "per-user install to a",
            doc,
            "the MSI is per-machine; a per-user claim would mislead the operator",
        )
        self.assertIn(
            "per-machine",
            doc,
            "the docstring must state the real install scope",
        )


if __name__ == "__main__":
    unittest.main()
