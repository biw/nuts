const _ = require("lodash")
const Q = require("q")
const semver = require("semver")

const platforms = require("./utils/platforms")

// Normalize tag name
const normalizeTag = (tag) => {
  if (tag[0] == "v") tag = tag.slice(1)
  return tag
}

// Extract channel of version
const extractChannel = (tag) => {
  const suffix = tag.split("-")[1]
  if (!suffix) return "stable"

  return suffix.split(".")[0]
}

// Normalize a release to a version
const normalizeVersion = (release) => {
  // Ignore draft
  if (release.draft) return null

  let downloadCount = 0
  const releasePlatforms = _.chain(release.assets)
    .map((asset) => {
      const platform = platforms.detect(asset.name)
      if (!platform) return null

      downloadCount = downloadCount + asset.download_count
      return {
        id: String(asset.id),
        type: platform,
        filename: asset.name,
        size: asset.size,
        content_type: asset.content_type,
        raw: asset,
      }
    })
    .compact()
    .value()

  return {
    tag: normalizeTag(release.tag_name).split("-")[0],
    channel: extractChannel(release.tag_name),
    notes: release.body || "",
    published_at: new Date(release.published_at),
    platforms: releasePlatforms,
  }
}

// Compare two version
const compareVersions = (v1, v2) => {
  if (semver.gt(v1.tag, v2.tag)) {
    return -1
  }
  if (semver.lt(v1.tag, v2.tag)) {
    return 1
  }
  return 0
}

function Versions(backend) {
  this.backend = backend
}

// List versions normalized
Versions.prototype.list = function () {
  return this.backend.releases().then((releases) => {
    return _.chain(releases)
      .map(normalizeVersion)
      .compact()
      .sort(compareVersions)
      .value()
  })
}

//  Get a specific version by its tag
Versions.prototype.get = function (tag) {
  return this.resolve({
    tag: tag,
  })
}

// Filter versions with criterias
Versions.prototype.filter = function (opts) {
  opts = _.defaults(opts || {}, {
    tag: "latest",
    platform: null,
    channel: "stable",
  })
  if (opts.platform) opts.platform = platforms.detect(opts.platform)

  return this.list().then((versions) => {
    return _.chain(versions)
      .filter((version) => {
        // Check channel
        if (opts.channel != "*" && version.channel != opts.channel) {
          return false
        }

        // Not available for requested paltform
        if (
          opts.platform &&
          !platforms.satisfies(opts.platform, _.map(version.platforms, "type"))
        ) {
          return false
        }

        // Check tag satisfies request version
        return opts.tag == "latest" || semver.satisfies(version.tag, opts.tag)
      })
      .value()
  })
}

// Resolve a platform, by filtering then taking the first result
Versions.prototype.resolve = function (opts) {
  return this.filter(opts).then((versions) => {
    const version = _.first(versions)
    if (!version) throw new Error("Version not found: " + opts.tag)

    return version
  })
}

// List all channels from releases
Versions.prototype.channels = function (opts) {
  return this.list().then((versions) => {
    const channels = {}

    _.each(versions, (version) => {
      if (!channels[version.channel]) {
        channels[version.channel] = {
          latest: null,
          versions_count: 0,
          published_at: 0,
        }
      }

      channels[version.channel].versions_count += 1
      if (channels[version.channel].published_at < version.published_at) {
        channels[version.channel].latest = version.tag
        channels[version.channel].published_at = version.published_at
      }
    })

    return channels
  })
}

module.exports = Versions
