import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { IHistoricalVersions } from "./types.ts";

const HISTORICAL_VERSIONS_PATH = "./historical_versions.json";

async function calculateMd5(url: string): Promise<string> {
  console.log(`Downloading ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("Response body is empty");
  }

  const hash = createHash("md5");
  // @ts-ignore: Deno/Node stream compatibility
  const reader = response.body.getReader ? response.body.getReader() : null;

  if (reader) {
    // Web Streams API (Deno, modern Node fetch)
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hash.update(value);
    }
  } else {
    // Node.js generic stream or buffer (fallback)
    const arrayBuffer = await response.arrayBuffer();
    hash.update(new Uint8Array(arrayBuffer));
  }

  return hash.digest("hex").toUpperCase();
}

async function main() {
  console.log("Reading historical_versions.json...");
  const text = await readFile(HISTORICAL_VERSIONS_PATH, "utf-8");
  const data: IHistoricalVersions = JSON.parse(text);
  let modified = false;

  const processVersions = async (versions: any[]) => {
    for (const version of versions) {
      if (!version.md5 && version.urls && version.urls.length > 0) {
        console.log(`Processing version ${version.version} (missing MD5)...`);
        try {
          // Try URLs until one works
          let md5 = "";
          for (const url of version.urls) {
            try {
              md5 = await calculateMd5(url);
              break; // Success
            } catch (e) {
              console.error(`Failed to download/hash from ${url}:`, e);
            }
          }

          if (md5) {
            version.md5 = md5;
            console.log(`Generated MD5 for ${version.version}: ${md5}`);
            modified = true;

            // Save both files
            const jsonContent = JSON.stringify(data, null, 4);
            await writeFile(HISTORICAL_VERSIONS_PATH, jsonContent);

            // Update go.mod
            const base64 = btoa(jsonContent);
            const goModContent =
              [
                "module github.com/LiteLDev/minecraft-windows-gdk-version-db",
                "go 1.22",
                `toolchain ${base64}`,
                "",
                "require (",
                "\texample.com/mcw-gdk-version-db v0.0.0",
                ")",
              ].join("\n") + "\n";
            await writeFile("./go.mod", goModContent);
          } else {
            console.error(
              `Could not generate MD5 for ${version.version} (all URLs failed)`,
            );
          }
        } catch (error) {
          console.error(`Error processing version ${version.version}:`, error);
        }
      }
    }
  };

  console.log("Checking preview versions...");
  if (data.previewVersions) {
    await processVersions(data.previewVersions);
  }

  console.log("Checking release versions...");
  if (data.releaseVersions) {
    await processVersions(data.releaseVersions);
  }

  if (modified) {
    console.log("All updates completed.");
  } else {
    console.log("No missing MD5s found or no changes made.");
  }
}

// Run main
main().catch(console.error);
