import json
import unittest

from tools.build_node_sbom import build_sbom
from tools.sanitize_pnpm_licenses import sanitize


class ReleaseToolsTests(unittest.TestCase):
    def test_sbom_is_deterministic_and_drops_paths_and_registry_urls(self):
        source = [
            {
                "name": "synthetic-app",
                "dependencies": {
                    "example-lib": {
                        "version": "1.2.3",
                        "path": "/private-source/node_modules/example-lib",
                        "resolved": "https://private-registry.example.invalid/example-lib.tgz",
                        "dependencies": {"nested-lib": {"version": "4.5.6"}},
                    },
                    "workspace-lib": {"version": "link:../../packages/workspace-lib"},
                },
            }
        ]
        first = build_sbom(source)
        second = build_sbom(source)
        self.assertEqual(first, second)
        serialized = json.dumps(first, ensure_ascii=False)
        self.assertNotIn("/private-source/", serialized)
        self.assertNotIn("private-registry.example.invalid", serialized)
        self.assertEqual(
            [(item["name"], item["version"]) for item in first["components"]],
            [("example-lib", "1.2.3"), ("nested-lib", "4.5.6")],
        )

    def test_license_inventory_drops_machine_paths(self):
        sanitized = sanitize(
            {
                "MIT": [
                    {
                        "name": "example-lib",
                        "versions": ["1.2.3"],
                        "license": "MIT",
                        "paths": ["/private-source/node_modules/example-lib"],
                    }
                ]
            }
        )
        serialized = json.dumps(sanitized, ensure_ascii=False)
        self.assertNotIn("paths", serialized)
        self.assertNotIn("private-source", serialized)
if __name__ == "__main__":
    unittest.main()
