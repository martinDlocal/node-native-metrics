'use strict'

// This file is largely based upon the work done for node-pre-gyp. We are not
// using that module directly due to issues we've run into with the intricacies
// of various node and npm versions that we must support.
// https://www.npmjs.com/package/node-pre-gyp

// XXX This file must not have any deps. This file will run during the install
// XXX step of the module and we are _not_ guaranteed that the dependencies have
// XXX already installed. Core modules are okay.
var cp = require('child_process')
var fs = require('fs')
var https = require('https')
var os = require('os')
var path = require('path')
var zlib = require('zlib')


var CPU_COUNT = os.cpus().length
var IS_WIN = process.platform === 'win32'
var S3_BUCKET = 'nr-downloads-main'
var DOWNLOAD_HOST = 'https://download.newrelic.com/'
var REMOTE_PATH = 'nodejs_agent/builds/'
var PACKAGE_ROOT = path.resolve(__dirname, '..')
var BUILD_PATH = path.resolve(PACKAGE_ROOT, './build/Release')


var opts = {}
exports.load = load

if (require.main === module) {
  var argv = parseArgs(process.argv, opts)
  executeCli(argv[2], argv[3])
}


function _getFileName() {
  var abi = process.versions.modules
  var arch = process.arch
  var platform = process.platform
  var pkg = require('../package')
  var pkgName = pkg.name.replace(/[^\w]/g, '_')
  var pkgVersion = pkg.version.toString().replace(/[^\w]/g, '_')

  if (!abi || !arch || !platform || !pkg || !pkgName || !pkgVersion) {
    throw new Error('Missing information for naming compiled binary.')
  }

  return pkgName + '-' + pkgVersion + '-' + abi + '-' + platform + '-' + arch
}

function getBinFileName() {
  return _getFileName() + '.node'
}

function getPackageFileName() {
  return _getFileName() + '.gz'
}

function load() {
  return require(path.join(BUILD_PATH, getBinFileName()))
}

function makePath(pathToMake, cb) {
  var accessRights = null
  if (fs.constants) {
    accessRights = fs.constants.R_OK | fs.constants.W_OK
  } else {
    // TODO: Remove this when deprecating Node v5 and below.
    accessRights = fs.R_OK | fs.W_OK
  }

  // We only want to make the parts after the package directory.
  pathToMake = path.relative(PACKAGE_ROOT, pathToMake)

  // Now that we have a relative path, split it into the parts we need to make.
  var pathParts = pathToMake.split(path.sep)
  _make(-1, PACKAGE_ROOT, cb)

  function _make(i, p, cb) {
    if (++i >= pathParts.length) {
      return cb()
    }
    p = path.join(p, pathParts[i])

    fs.access(p, accessRights, function fsAccessCB(err) {
      if (!err) {
        // It exists! Move on to the next part.
        return _make(i, p, cb)
      }

      // It probably does not exist, so try to make it.
      fs.mkdir(p, function fsMkDirCB(err) {
        if (err) {
          return cb(err)
        }
        _make(i, p, cb)
      })
    })
  }
}

function execGyp(args, cb) {
  var spawnOpts = {}
  if (!opts.quiet) {
    spawnOpts.stdio = [0, 1, 2]
  }
  console.log('> node-gyp ' + args.join(' ')) // eslint-disable-line no-console

  var child = cp.spawn('node-gyp', args, spawnOpts)
  child.on('error', function onGypError(err) {
    cb(new Error('Failed to execute node-gyp ' + args.join(' ') + ': ' + err))
  })
  child.on('close', function onGypClose(code) {
    if (code !== 0) {
      cb(new Error('Failed to execute node-gyp ' + args.join(' ') + ': code ' + code))
    } else {
      cb(null)
    }
  })
}

function build(target, rebuild, cb) {
  if (IS_WIN) {
    target = '/t:' + target
  }

  var cmds = rebuild ? ['clean', 'configure'] : ['configure']

  execGyp(cmds, function cleanCb(err) {
    if (err) {
      return cb(err)
    }

    var jobs = Math.round(CPU_COUNT / 2)
    execGyp(['build', '-j', jobs, target], cb)
  })
}

function moveBuild(target, cb) {
  var filePath = path.join(BUILD_PATH, target + '.node')
  var destination = path.join(BUILD_PATH, getBinFileName())
  fs.rename(filePath, destination, cb)
}

function download(cb) {
  var hasCalledBack = false
  var fileName = getPackageFileName()
  var url = DOWNLOAD_HOST + REMOTE_PATH + fileName
  https.get(url, function getFile(res) {
    if (res.statusCode !== 200) {
      return cb(new Error('Failed to download ' + url + ': code ' + res.statusCode))
    }

    var unzip = zlib.createGunzip()
    var buffers = []
    var size = 0
    res.pipe(unzip).on('data', function onResData(data) {
      buffers.push(data)
      size += data.length
    })

    res.on('error', function onResError(err) {
      if (!hasCalledBack) {
        hasCalledBack = true
        cb(new Error('Failed to download ' + url + ': ' + err))
      }
    })

    unzip.on('error', function onResError(err) {
      if (!hasCalledBack) {
        hasCalledBack = true
        cb(new Error('Failed to unzip ' + url + ': ' + err))
      }
    })

    unzip.on('end', function onResEnd() {
      if (hasCalledBack) {
        return
      }
      hasCalledBack = true
      cb(null, Buffer.concat(buffers, size))
    })

    res.resume()
  })
}

function saveDownload(data, cb) {
  makePath(BUILD_PATH, function makePathCB(err) {
    if (err) {
      return cb(err)
    }

    var filePath = path.join(BUILD_PATH, getBinFileName())
    fs.writeFile(filePath, data, cb)
  })
}

function install(target, cb) {
  // First, attempt to build the package using the source. If that fails, try
  // downloading the package. If that also fails, whoops!
  var errors = []
  build(target, true, function buildCB(err) {
    if (!err) {
      return moveBuild(target, function moveBuildCB(err) {
        if (err) {
          errors.push(err)
          doDownload()
        } else {
          doCallback()
        }
      })
    }
    errors.push(err)

    // Building failed, try downloading.
    doDownload()
  })

  function doDownload() {
    if (opts['no-download']) {
      return doCallback(new Error('Downloading is disabled.'))
    }

    download(function downloadCB(err, data) {
      if (err) {
        return doCallback(err)
      }

      saveDownload(data, doCallback)
    })
  }

  function doCallback(err) {
    if (err) {
      errors.push(err)
    }

    if (errors.length > 0) {
      cb(new Error('Failed to install module: ' + errors.join('; ')))
    } else {
      cb()
    }
  }
}

function upload(cb) {
  // XXX This is the one external dep allowed by this module. The aws-sdk must
  // XXX be a dev-dep of the module and uploading should only be done after
  // XXX installing.

  var zip = zlib.createGzip()
  fs.createReadStream(path.join(BUILD_PATH, getBinFileName())).pipe(zip)

  // AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in the environment.
  var AWS = require('aws-sdk')
  var s3 = new AWS.S3()
  s3.upload({
    Bucket: S3_BUCKET,
    Key: path.join(REMOTE_PATH, getPackageFileName()),
    Body: zip
  }, function s3UploadCb(err) {
    if (err) {
      cb(new Error('Failed to upload file: ' + err))
    } else {
      cb()
    }
  })
}

function parseArgs(_argv, _opts) {
  var args = []
  for (var i = 0; i < _argv.length; ++i) {
    if (/^--/.test(_argv[i])) {
      _opts[_argv[i].substr(2)] = true
    } else {
      args.push(_argv[i])
    }
  }
  return args
}

function executeCli(cmd, target) {
  if (cmd === 'build' || cmd === 'rebuild') {
    build(target, cmd === 'rebuild', function buildCb(err) {
      if (err) {
        _endCli(err)
      } else {
        moveBuild(target, _endCli)
      }
    })
  } else if (cmd === 'install') {
    install(target, _endCli)
  } else if (cmd === 'upload') {
    upload(_endCli)
  }

  function _endCli(err) {
    /* eslint-disable no-console */
    if (err) {
      console.error(new Error('Failed to execute ' + cmd + ': ' + err).toString())
      process.exit(1)
    } else {
      console.log(cmd + ' successful: ' + _getFileName())
    }
    /* eslint-enable no-console */
  }
}
