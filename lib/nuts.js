const _ = require("lodash")
const Q = require("q")
const Feed = require("feed")
const urljoin = require("urljoin.js")
const Understudy = require("understudy")
const express = require("express")
const useragent = require("express-useragent")

const BACKENDS = require("./backends")
const Versions = require("./versions")
const notes = require("./utils/notes")
const platforms = require("./utils/platforms")
const winReleases = require("./utils/win-releases")
const API_METHODS = require("./api")

const getFullUrl = (req) => {
  return req.protocol + "://" + req.get("host") + req.originalUrl
}

function Nuts(opts) {
  if (!(this instanceof Nuts)) return new Nuts(opts)

  Understudy.call(this)
  _.bindAll(this)

  this.opts = _.defaults(opts || {}, {
    // Backend to use
    backend: "github",

    // Timeout for releases cache (seconds)
    timeout: 60 * 60 * 1000,

    // Pre-fetch list of releases at startup
    preFetch: true,

    // Secret for GitHub webhook
    refreshSecret: "secret",

    // Prefix for all routes
    routePrefix: "/",
  })

  if (
    this.opts.routePrefix.substr(this.opts.routePrefix.length - 1, 1) !== "/"
  ) {
    throw new Error("ROUTE_PREIX must end with a slash")
  }

  // .init() is now a memoized version of ._init()
  this.init = _.memoize(this._init)

  // Create router
  this.router = express.Router()

  // Create backend
  this.backend = new (BACKENDS(this.opts.backend))(this, this.opts)
  this.versions = new Versions(this.backend)

  // Bind routes
  this.router.use(useragent.express())

  const withPrefix = (s) => `${this.opts.routePrefix}${s}`

  this.router.get(withPrefix(""), this.onDownload)
  this.router.get(
    withPrefix(`download/channel/:channel/:platform?`),
    this.onDownload,
  )
  this.router.get(
    withPrefix(`download/version/:tag/:platform?`),
    this.onDownload,
  )
  this.router.get(withPrefix(`download/:tag/:filename`), this.onDownload)
  this.router.get(withPrefix(`download/:platform?`), this.onDownload)

  this.router.get(
    withPrefix(`feed/channel/:channel.atom`),
    this.onServeVersionsFeed,
  )

  this.router.get(withPrefix(`update`), this.onUpdateRedirect)
  this.router.get(withPrefix(`update/:platform/:version`), this.onUpdate)
  this.router.get(
    withPrefix(`update/channel/:channel/:platform/:version`),
    this.onUpdate,
  )
  this.router.get(
    withPrefix(`update/:platform/:version/RELEASES`),
    this.onUpdateWin,
  )
  this.router.get(
    withPrefix(`update/channel/:channel/:platform/:version/RELEASES`),
    this.onUpdateWin,
  )

  this.router.get(withPrefix(`notes/:version?`), this.onServeNotes)

  // Bind API
  this.router.use(withPrefix(`api`), this.onAPIAccessControl)
  _.each(API_METHODS, (method, route) => {
    this.router.get(withPrefix(`api/${route}`), (req, res, next) => {
      return Q()
        .then(() => {
          return method.call(this, req)
        })
        .then((result) => {
          res.send(result)
        }, next)
    })
  })
}

// _init does the real init work, initializing backend and prefetching versions
Nuts.prototype._init = function () {
  return Q()
    .then(() => {
      return this.backend.init()
    })
    .then(() => {
      if (!this.opts.preFetch) return
      return this.versions.list()
    })
}

// Perform a hook using promised functions
Nuts.prototype.performQ = function (name, arg, fn) {
  fn = fn || function () {}

  return Q.nfcall(this.perform, name, arg, function (next) {
    Q()
      .then(() => {
        return fn.call(this, arg)
      })
      .then(() => {
        next()
      }, next)
  })
}

// Serve an asset to the response
Nuts.prototype.serveAsset = function (req, res, version, asset) {
  return this.init().then(() => {
    return this.performQ(
      "download",
      {
        req: req,
        version: version,
        platform: asset,
      },
      () => {
        return this.backend.serveAsset(asset, req, res)
      },
    )
  })
}

// Handler for download routes
Nuts.prototype.onDownload = function (req, res, next) {
  let platform = req.params.platform
  const tag = req.params.tag || "latest"
  // If specific version, don't enforce a channel
  const channel = tag != "latest" ? "*" : req.params.channel
  const filename = req.params.filename
  const filetypeWanted = req.query.filetype

  // When serving a specific file, platform is not required
  if (!filename) {
    // Detect platform from useragent
    if (!platform) {
      platform = platforms.detectPlatformByUserAgent(req.useragent)
    }
    if (!platform) {
      res.status(400).send("No platform specified and impossible to detect one")
      return
    }
  } else {
    platform = null
  }

  this.versions
    .resolve({
      channel: channel,
      platform: platform,
      tag: tag,
    })

    .fail((err) => {
      // Fallback to any channels if no version found on stable one
      if (channel || tag != "latest") throw err

      return this.versions.resolve({
        channel: "*",
        platform: platform,
        tag: tag,
      })
    })
    .then((version) => {
      // Serve downloads
      let asset

      if (filename) {
        asset = _.find(version.platforms, {
          filename: filename,
        })
      } else {
        asset = platforms.resolve(version, platform, {
          wanted: filetypeWanted ? "." + filetypeWanted : null,
        })
      }

      if (!asset) {
        res
          .status(400)
          .send(
            `No download available for platform ${_.escape(
              platform,
            )} for version ${version.tag} (${channel || "beta"})`,
          )
        return
      }

      // Call analytic middleware, then serve
      return this.serveAsset(req, res, version, asset)
    })
    .fail(() => {
      res.status(400).send("No download available for platform " + platform)
    })
}

// Request to update
Nuts.prototype.onUpdateRedirect = function (req, res, next) {
  const that = this

  Q()
    .then(() => {
      if (!req.query.version) throw new Error('Requires "version" parameter')
      if (!req.query.platform) throw new Error('Requires "platform" parameter')

      return res.redirect(
        `${that.opts.routePrefix}update/${req.query.platform}/${req.query.version}`,
      )
    })
    .fail(next)
}

// Updater used by OSX (Squirrel.Mac) and others
Nuts.prototype.onUpdate = function (req, res, next) {
  const fullUrl = getFullUrl(req)
  let platform = req.params.platform
  const channel = req.params.channel || "*"
  const tag = req.params.version
  const filetype = req.query.filetype ? req.query.filetype : "zip"

  Q()
    .then(() => {
      if (!tag) throw new Error('Requires "version" parameter')
      if (!platform) throw new Error('Requires "platform" parameter')

      platform = platforms.detect(platform)

      return this.versions.filter({
        tag: ">=" + tag,
        platform: platform,
        channel: channel,
      })
    })
    .then(function (versions) {
      const latest = _.first(versions)
      if (!latest || latest.tag == tag)
        return res.status(204).send("No updates")

      let notesSlice = versions.slice(0, -1)
      if (versions.length === 1) {
        notesSlice = [versions[0]]
      }
      const releaseNotes = notes.merge(notesSlice, { includeTag: false })
      console.error(latest.tag)
      const gitFilePath = channel === "*" ? "/../../../" : "/../../../../../"
      res.status(200).send({
        url: urljoin(
          fullUrl,
          gitFilePath,
          `download/version/${latest.tag}/${platform}?filetype=${filetype}`,
        ),
        name: latest.tag,
        notes: releaseNotes,
        pub_date: latest.published_at.toISOString(),
      })
    })
    .fail(next)
}

// Update Windows (Squirrel.Windows)
// Auto-updates: Squirrel.Windows: serve RELEASES from latest version
// Currently, it will only serve a full.nupkg of the latest release with a normalized filename (for pre-release)
Nuts.prototype.onUpdateWin = function (req, res, next) {
  const fullUrl = getFullUrl(req)
  let platform = "win_32"
  const channel = req.params.channel || "*"
  const tag = req.params.version

  this.init()
    .then(() => {
      platform = platforms.detect(platform)

      return this.versions.filter({
        tag: ">=" + tag,
        platform: platform,
        channel: channel,
      })
    })
    .then((versions) => {
      // Update needed?
      const latest = _.first(versions)
      if (!latest) throw new Error("Version not found")

      // File exists
      const asset = _.find(latest.platforms, {
        filename: "RELEASES",
      })
      if (!asset) throw new Error("File not found")

      return this.backend.readAsset(asset).then((content) => {
        let releases = winReleases.parse(content.toString("utf-8"))

        releases = _.chain(releases)
          // Change filename to use download proxy
          .map((entry) => {
            const gitFilePath =
              channel === "*" ? "../../../../" : "../../../../../../"
            entry.filename = urljoin(
              fullUrl,
              gitFilePath,
              `download/${entry.semver}/${entry.filename}`,
            )

            return entry
          })
          .value()

        const output = winReleases.generate(releases)

        res.header("Content-Length", output.length)
        res.attachment("RELEASES")
        res.send(output)
      })
    })
    .fail(next)
}

// Serve releases notes
Nuts.prototype.onServeNotes = function (req, res, next) {
  const tag = req.params.version

  Q()
    .then(() =>
      this.versions.filter({
        tag: tag ? ">=" + tag : "*",
        channel: "*",
      }),
    )
    .then((versions) => {
      const latest = _.first(versions)

      if (!latest) throw new Error("No versions matching")

      res.format({
        "text/plain": () => {
          res.send(notes.merge(versions))
        },
        "application/json": () => {
          res.send({
            notes: notes.merge(versions, { includeTag: false }),
            pub_date: latest.published_at.toISOString(),
          })
        },
        default: () => {
          res.send(releaseNotes)
        },
      })
    })
    .fail(next)
}

// Serve versions list as RSS
Nuts.prototype.onServeVersionsFeed = function (req, res, next) {
  const channel = req.params.channel || "all"
  const channelId = channel === "all" ? "*" : channel
  const fullUrl = getFullUrl(req)

  const feed = new Feed({
    id: "versions/channels/" + channel,
    title: "Versions (" + channel + ")",
    link: fullUrl,
  })

  Q()
    .then(() => {
      return this.versions.filter({
        channel: channelId,
      })
    })
    .then((versions) => {
      _.each(versions, (version) => {
        feed.addItem({
          title: version.tag,
          link: urljoin(
            fullUrl,
            "/../../../",
            `download/version/${version.tag}`,
          ),
          description: version.notes,
          date: version.published_at,
          author: [],
        })
      })

      res.set("Content-Type", "application/atom+xml; charset=utf-8")
      res.send(feed.render("atom-1.0"))
    })
    .fail(next)
}

// Control access to the API
Nuts.prototype.onAPIAccessControl = function (req, res, next) {
  this.performQ("api", {
    req: req,
    res: res,
  }).then(() => {
    next()
  }, next)
}

module.exports = Nuts
