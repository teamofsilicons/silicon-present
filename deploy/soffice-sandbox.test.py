import importlib.machinery
import importlib.util
from pathlib import Path
import unittest

loader = importlib.machinery.SourceFileLoader("sandbox", str(Path(__file__).with_name("soffice-sandbox.py")))
spec = importlib.util.spec_from_loader(loader.name, loader)
sandbox = importlib.util.module_from_spec(spec)
loader.exec_module(sandbox)


class Arguments(unittest.TestCase):
    def arguments(self):
        base = "/var/lib/present-converter/tmp/silicon-present-converter-123"
        return [f"-env:UserInstallation=file://{base}/lo-profile", *sandbox.FLAGS,
                "--convert-to", "pptx", "--outdir", f"{base}/job-a1-1/pptx", f"{base}/job-a1-1/in.odp"]

    def test_supported_conversions(self):
        for fmt in sandbox.FORMATS:
            arguments = self.arguments()
            arguments[7] = fmt
            self.assertIsNotNone(sandbox.validate_arguments(arguments))
        self.assertIsNone(sandbox.validate_arguments(["--self-check"]))

    def test_rejects_extra_options_and_custom_filters(self):
        for args in [self.arguments() + ["--accept=socket,host=0.0.0.0"], ["--version"], ["--self-check", "sh"]]:
            with self.assertRaises(sandbox.Refused):
                sandbox.validate_arguments(args)
        for position, value in [(1, "--headless;id"), (7, "pdf:arbitrary"), (7, "--help")]:
            args = self.arguments()
            args[position] = value
            with self.assertRaises(sandbox.Refused):
                sandbox.validate_arguments(args)

    def test_rejects_path_traversal_and_other_jobs(self):
        for value in ["/etc/shadow", "/var/lib/present-converter/tmp/../secret", "relative", "//etc/shadow",
                      "/var/lib/present-converter/tmp/silicon-present-converter-123/job-a1-1/../secret"]:
            args = self.arguments()
            args[10] = value
            with self.assertRaises(sandbox.Refused):
                sandbox.validate_arguments(args)
        args = self.arguments()
        args[9] = args[9].replace("job-a1-1", "job-a1-2")
        with self.assertRaises(sandbox.Refused):
            sandbox.validate_arguments(args)

    def test_namespace_and_privilege_contract(self):
        args = self.arguments()
        cmd = sandbox.command(991, 991, args)
        for option in ["--unshare-net", "--unshare-pid", "--unshare-ipc", "--clearenv", "--new-session",
                       "--no-new-privs", "--bounding-set=-all", "--clear-groups", "--reuid=991", "--regid=991"]:
            self.assertIn(option, cmd)
        self.assertNotIn("--unshare-user", cmd)
        self.assertEqual(cmd[-12:], ["/usr/bin/soffice", *args])
        self.assertNotIn("/etc/present", cmd)
        self.assertNotIn("/opt/present", cmd)
        self.assertEqual(cmd[cmd.index("--bind") + 1:cmd.index("--bind") + 3], [str(sandbox.TEMP)] * 2)


if __name__ == "__main__":
    unittest.main()
