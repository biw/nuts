const _ = require("lodash")
const semver = require("semver")
const stripBom = require("strip-bom")

// Ordered list of supported channel
const CHANNEL_MAGINITUDE = 1000
const CHANNELS = ["alpha", "beta", "unstable", "rc"]

// RELEASES parsing
const releaseRe = /^([0-9a-fA-F]{40})\s+(\S+)\s+(\d+)[\r]*$/

// Hash a prerelease
const hashPrerelease = (s) => {
  if (_.isString(s[0])) {
    return (_.indexOf(CHANNELS, s[0]) + 1) * CHANNEL_MAGINITUDE + (s[1] || 0)
  } else {
    return s[0]
  }
}

// Map a semver version to a windows version
const normVersion = (tag) => {
  const parts = new semver.SemVer(tag)
  let prerelease = ""

  if (parts.prerelease && parts.prerelease.length > 0) {
    prerelease = hashPrerelease(parts.prerelease)
  }

  return (
    [parts.major, parts.minor, parts.patch].join(".") +
    (prerelease ? "." + prerelease : "")
  )
}

// Map a windows version to a semver
const toSemver = (tag) => {
  const parts = tag.split(".")
  const version = parts.slice(0, 3).join(".")
  const prerelease = Number(parts[3])

  // semver == windows version
  if (!prerelease) return version

  const channelId = Math.floor(prerelease / CHANNEL_MAGINITUDE)
  const channel = CHANNELS[channelId - 1]
  const count = prerelease - channelId * CHANNEL_MAGINITUDE

  return version + "-" + channel + "." + count
}

// Parse RELEASES file
// https://github.com/Squirrel/Squirrel.Windows/blob/0d1250aa6f0c25fe22e92add78af327d1277d97d/src/Squirrel/ReleaseExtensions.cs#L19
const parseRELEASES = (content) => {
  return _.chain(stripBom(content))
    .replace("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const parts = releaseRe.exec(line)
      if (!parts) return null

      const filename = parts[2]
      const isDelta = filename.indexOf("-full.nupkg") == -1

      const filenameParts = filename
        .replace(".nupkg", "")
        .replace("-delta", "")
        .replace("-full", "")
        .split(/\.|-/)
        .reverse()

      const version = _.chain(filenameParts)
        .filter((x) => {
          return /^\d+$/.exec(x)
        })
        .reverse()
        .value()
        .join(".")

      return {
        sha: parts[1],
        filename: filename,
        size: Number(parts[3]),
        isDelta: isDelta,
        version: version,
        semver: toSemver(version),
      }
    })
    .compact()
    .value()
}

// Generate a RELEASES file
const generateRELEASES = (entries) => {
  return _.map(entries, (entry) => {
    let filename = entry.filename

    if (!filename) {
      filename = [
        entry.app,
        entry.version,
        entry.isDelta ? "delta.nupkg" : "full.nupkg",
      ].join("-")
    }

    return [entry.sha, filename, entry.size].join(" ")
  }).join("\n")
}

module.exports = {
  normVersion: normVersion,
  toSemver: toSemver,
  parse: parseRELEASES,
  generate: generateRELEASES,
}
