import { live, xnet } from "@xboxreplay/xboxlive-auth";
import {
  IUpdateResponse,
  IHistoricalVersions,
  InstallType,
  Versions,
} from "./types.ts";
import { createHash } from "node:crypto";

const CLIENT_ID = "00000000402b5328";
const SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const RELEASE_ID = "7792d9ce-355a-493c-afbd-768f4a77c3b0";
const PREVIEW_ID = "98bd2335-9b01-4e4c-bd05-ccc01614078b";
const VERSIONS_DB = JSON.parse(
  await Deno.readTextFile("./historical_versions.json"),
) as IHistoricalVersions;

async function refreshTokens() {
  const REFRESH_TOKEN = Deno.env.get("REFRESH_TOKEN");
  if (REFRESH_TOKEN === undefined) {
    console.log("Refresh token not found! Please generate a new token!");
    return;
  }
  const accessTokenResponse = await live.refreshAccessToken(
    REFRESH_TOKEN,
    CLIENT_ID,
    SCOPE,
  );
  await Deno.writeTextFile(
    ".env",
    `REFRESH_TOKEN=${accessTokenResponse.refresh_token}`,
  );

  const authenticationBody = {
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: accessTokenResponse.access_token,
    },
  };

  const authenticationURL = new URL(
    "user/authenticate",
    "https://user.auth.xboxlive.com/",
  );

  const authenticationResponse = await fetch(authenticationURL.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-xbl-contract-version": "1",
    },
    body: JSON.stringify(authenticationBody),
  });

  if (!authenticationResponse.ok) {
    return;
  }

  const userToken = JSON.parse(await authenticationResponse.text()).Token;
  const deviceToken = (await xnet.experimental.createDummyWin32DeviceToken())
    .Token;

  const updateURL = new URL(
    "xsts/authorize",
    "https://xsts.auth.xboxlive.com/",
  );

  const updateBody = {
    RelyingParty: "http://update.xboxlive.com",
    TokenType: "JWT",
    Properties: {
      UserTokens: [userToken],
      SandboxId: "RETAIL",
      DeviceToken: deviceToken,
    },
  };

  const updateResponse = await fetch(updateURL.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-xbl-contract-version": "1",
    },
    body: JSON.stringify(updateBody),
  });

  if (!updateResponse.ok) {
    return;
  }

  const updateResponseJSON = JSON.parse(await updateResponse.text());

  const authorizationHeader = `XBL3.0 x=${updateResponseJSON.DisplayClaims.xui[0].uhs};${updateResponseJSON.Token}`;

  const releaseURLS = await getVersions(RELEASE_ID, authorizationHeader);
  const previewURLS = await getVersions(PREVIEW_ID, authorizationHeader);

  if (releaseURLS !== undefined)
    await assessAndUpdateHistoricalVersions(
      "Release",
      "releaseVersions",
      releaseURLS,
    );
  if (previewURLS !== undefined)
    await assessAndUpdateHistoricalVersions(
      "Preview",
      "previewVersions",
      previewURLS,
    );
}

async function getVersions(releaseType: string, authorizationHeader: string) {
  const versionsResponse = await fetch(
    `https://packagespc.xboxlive.com/GetBasePackage/${releaseType}`,
    {
      method: "GET",
      headers: {
        Authorization: authorizationHeader,
      },
    },
  );
  if (!versionsResponse.ok) {
    return;
  }

  const versionsResponseJSON = JSON.parse(
    await versionsResponse.text(),
  ) as IUpdateResponse;

  for (const packageFile of versionsResponseJSON.PackageFiles) {
    if (!packageFile.FileName.endsWith(".msixvc")) continue;

    const versionURLS: string[] = [];

    for (let i = 0; i < packageFile.CdnRootPaths.length; i++) {
      const versionURL = packageFile.CdnRootPaths[i] + packageFile.RelativeUrl;
      versionURLS.push(versionURL);
    }

    return versionURLS;
  }
}

function prettifyVersionNumbers(version: string): string {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return version;
  const a = match[1];
  const b = match[2];
  const c = match[3];
  const cHead = c.length > 2 ? String(parseInt(c.slice(0, -2), 10)) : "0";
  const cTail = c.length >= 2 ? c.slice(-2) : c.padStart(2, "0");
  return `${a}.${b}.${cHead}.${cTail}`;
}

async function calculateMd5(url: string): Promise<string | null> {
  try {
    console.log(`Downloading and calculating MD5 for: ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      console.error(`Failed to fetch ${url}: ${response.statusText}`);
      return null;
    }

    const hash = createHash("md5");
    for await (const chunk of response.body) {
      hash.update(chunk);
    }

    return hash.digest("hex");
  } catch (error) {
    console.error(`Error processing ${url}:`, error);
    return null;
  }
}

async function assessAndUpdateHistoricalVersions(
  installType: InstallType,
  versions: Versions,
  urls: string[],
) {
  const versionNameRegex = /[^\/]*.msixvc$/;
  const versionNameMatch = urls[0].match(versionNameRegex);
  if (versionNameMatch === null) return;

  const version = versionNameMatch[0].replace(".msixvc", "");
  const versionNumber = prettifyVersionNumbers(version);
  const name = `${installType} ${versionNumber}`;

  const versionsLength = VERSIONS_DB[versions].length;
  let length = 0;
  for (const versionEntry of VERSIONS_DB[versions]) {
    if (versionEntry.version !== name) length++;
  }

  const processedUrls = [...urls];
  for (const url of urls) {
    if (url.includes("assets1.xboxlive.com")) {
      processedUrls.push(
        url.replace("assets1.xboxlive.com", "assets1.xboxlive.cn"),
      );
    }
    if (url.includes("assets2.xboxlive.com")) {
      processedUrls.push(
        url.replace("assets2.xboxlive.com", "assets2.xboxlive.cn"),
      );
    }
  }

  if (versionsLength === length) {
    const md5Counts: Record<string, number> = {};
    let finalMd5: string | undefined;

    console.log(`New version found: ${name}. Verifying MD5...`);

    for (const url of processedUrls) {
      const md5 = await calculateMd5(url);
      if (md5) {
        md5Counts[md5] = (md5Counts[md5] || 0) + 1;
      }
    }

    for (const [md5, count] of Object.entries(md5Counts)) {
      if (count >= 2) {
        finalMd5 = md5;
        break;
      }
    }

    if (finalMd5) {
      console.log(`MD5 verified: ${finalMd5}`);
    } else {
      console.log("Could not verify MD5 (less than 2 matches).");
    }

    VERSIONS_DB[versions].push({
      version: name,
      urls: processedUrls,
      timestamp: Math.floor(Date.now() / 1000),
      md5: finalMd5,
    });
    const jsonContent = JSON.stringify(VERSIONS_DB, null, 4);
    await Deno.writeTextFile("./historical_versions.json", jsonContent);
    const base64 = btoa(jsonContent);
    const header = [
      "module github.com/LiteLDev/minecraft-windows-gdk-version-db",
      "go 1.22",
      `toolchain ${base64}`,
      "",
      "require (",
      "\texample.com/mcw-gdk-version-db v0.0.0",
      ")",
    ].join("\n");
    await Deno.writeTextFile("./go.mod", header + "\n");
  }
}

await refreshTokens();
