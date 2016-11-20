/* jslint node:true */

'use strict';

exports = module.exports = {
    getProfileByIdentifier: getProfileByIdentifier,
    getAll: getAll,
    getAllLean: getAllLean,
    get: get,
    add: add,
    put: put,
    del: del,
    exp: exp,
    imp: imp,
    extractURLs: extractURLs,
    extractTags: extractTags,
    facelift: facelift,
    cleanupTags: cleanupTags,
    importThings: importThings,

    // TODO remove eventually
    hasOldData: null,
    expOldData: expOldData,
    cleanupOldData: cleanupOldData,

    TYPE_IMAGE: 'image',
    TYPE_UNKNOWN: 'unknown'
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    path = require('path'),
    fs = require('fs'),
    ldapjs = require('ldapjs'),
    mkdirp = require('mkdirp'),
    url = require('url'),
    tags = require('./database/tags.js'),
    tar = require('tar-fs'),
    things = require('./database/things.js'),
    rimraf = require('rimraf'),
    safe = require('safetydance'),
    superagent = require('superagent');

var GET_URL = new RegExp('(^|[ \t\r\n])((ftp|http|https|gopher|mailto|news|nntp|telnet|wais|file|prospero|aim|webcal):(([A-Za-z0-9$_.+!*(),;/?:@&~=-])|%[A-Fa-f0-9]{2}){2,}(#([a-zA-Z0-9$_.+!*(),;/?:@&~=%-]*))?([A-Za-z0-9$_+!*();/?:~-]))', 'g');
var PRETTY_URL_LENGTH = 40;

// identifier may be userId, email, username
function getProfileByIdentifier(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    var ldapClient = ldapjs.createClient({ url: process.env.LDAP_URL });
    ldapClient.on('error', function (error) {
        console.error('LDAP error', error);
        callback(error);
    });

    ldapClient.search(process.env.LDAP_USERS_BASE_DN, { filter: '(|(uid=' + identifier + ')(mail=' + identifier + ')(username=' + identifier + '))' }, function (error, result) {
        if (error) return callback(error);

        var items = [];

        result.on('searchEntry', function(entry) {
            items.push(entry.object);
        });

        result.on('error', function (error) {
            callback(error);
        });

        result.on('end', function (result) {
            if (result.status !== 0) return callback(new Error('non-zero status from LDAP search: ' + result.status));
            if (items.length === 0) return callback(new Error('Duplicate entries found'));

            var out = {
                id: items[0].uid,
                username: items[0].username,
                displayName: items[0].displayname,
                email: items[0].mail
            };

            callback(null, out);
        });
    });
}

function extractURLs(content) {
    var lines = content.split('\n');
    var urls = [];

    lines.forEach(function (line) {
        var tmp = line.match(GET_URL);
        if (tmp === null) return;

        urls = urls.concat(tmp.map(function (url) {
            return url.trim();
        }));
    });

    return urls.filter(function (item, pos, self) {
        return self.indexOf(item) === pos;
    });
}

function escapeRegExp(str) {
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

function extractTags(content) {
    var tagObjects = [];

    // first replace all urls which might contain # with placeholders
    var urls = extractURLs(content);
    urls.forEach(function (u) {
        content = content.replace(new RegExp(escapeRegExp(u), 'gmi'), ' --URL_PLACEHOLDER-- ');
    });

    var lines = content.split('\n');
    lines.forEach(function (line) {
        var tmp = line.match(/#([\u00C0-\u017Fa-zA-Z0-9]+)/g);
        if (tmp === null) return;

        tagObjects = tagObjects.concat(tmp.map(function (tag) {
            return tag.slice(1).toLowerCase();
        }));
    });

    return tagObjects;
}

function extractExternalContent(content, callback) {
    var urls = extractURLs(content);
    var externalContent = [];

    async.each(urls, function (url, callback) {
        superagent.head(url).timeout(20000).end(function (error, result) {
            var obj = { url: url, type: exports.TYPE_UNKNOWN };

            if (error) {
                console.log('[WARN] failed to fetch external content %s', url);
            } else {
                if (result.type.indexOf('image/') === 0) {
                    obj = { url: url, type: exports.TYPE_IMAGE };
                }

                console.log('[INFO] external content type %s - %s', obj.type, obj.url);
            }

            externalContent.push(obj);

            callback(null);
        });
    }, function () {
        callback(null, externalContent);
    });
}

function facelift(userId, thing, callback) {
    var data = thing.content;
    var tagObjects = thing.tags;
    var externalContent = thing.externalContent;
    var attachments = thing.attachments || [];

    function wrapper() {

        // Enrich with tag links
        tagObjects.forEach(function (tag) {
            data = data.replace(new RegExp('#' + tag + '(#|\\s|$)', 'gmi'), '[#' + tag + '](#search?#' + tag + ')$1').trim();
        });

        // Enrich with image links
        externalContent.forEach(function (obj) {
            if (obj.type === exports.TYPE_IMAGE) {
                data = data.replace(new RegExp(escapeRegExp(obj.url), 'gmi'), '![' + obj.url + '](' + obj.url + ')');
            } else {
                // make urls look prettier
                var tmp = url.parse(obj.url);

                var pretty = obj.url.slice(tmp.protocol.length + 2);
                if (pretty.length > PRETTY_URL_LENGTH) pretty = pretty.slice(0, PRETTY_URL_LENGTH) + '...';

                data = data.replace(new RegExp(escapeRegExp(obj.url), 'gmi'), '[' + pretty + '](' + obj.url + ')');
            }
        });

        // Enrich with attachments
        attachments.forEach(function (a) {
            if (a.type === exports.TYPE_IMAGE) {
                data = data.replace(new RegExp('\\[' + a.fileName + '\\]', 'gmi'), '![/api/files/' + userId + '/' + a.identifier + '](/api/files/' + userId + '/' + a.identifier + ')');
            } else {
                data = data.replace(new RegExp('\\[' + a.fileName + '\\]', 'gmi'), '[/api/files/' + userId + '/' + a.identifier + '](/api/files/' + userId + '/' + a.identifier + ')');
            }
        });

        callback(null, data);
    }

    if (Array.isArray(externalContent)) return wrapper();

    // old entry extract external content first
    extractExternalContent(thing.content, function (error, result) {
        if (error) {
            console.error('Failed to extract external content:', error);

            externalContent = [];

            return wrapper();
        }

        // set for wrapper()
        externalContent = result;

        console.log('[INFO] update %s with new external content.', thing._id, result);

        things.put(userId, thing._id, thing.content, thing.tags, attachments, result, function (error) {
            if (error) console.error('Failed to update external content:', error);

            wrapper();
        });
    });
}

function getAll(userId, query, skip, limit, callback) {
    things.getAll(userId, query, skip, limit, function (error, result) {
        if (error) return callback(error);
        if (!result) return callback(null, []);

        async.each(result, function (thing, callback) {
            facelift(userId, thing, function (error, data) {
                if (error) console.error('Failed to facelift:', error);

                thing.attachments = thing.attachments || [];
                thing.richContent = data || thing.content;

                callback(null);
            });
        }, function () {
            callback(null, result);
        });
    });
}

function getAllLean(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    things.getAllLean(userId, callback);
}

function get(userId, thingId, access, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof thingId, 'string');
    assert.strictEqual(typeof access, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!access) return callback('not allowed');

    things.get(userId, thingId, function (error, result) {
        if (error) return callback(error);

        if (result.acl.indexOf(access) === -1) return callback('not allowed');

        facelift(userId, result, function (error, data) {
            if (error) console.error('Failed to facelift:', error);

            result.attachments = result.attachments || [];
            result.richContent = data || result.content;

            callback(null, result);
        });
    });
}

function add(userId, content, attachments, callback) {
    extractExternalContent(content, function (error, result) {
        if (error) return callback(error);

        var doc = {
            content: content,
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            tags: extractTags(content),
            externalContent: result,
            attachments: attachments
        };

        async.eachSeries(doc.tags, tags.update.bind(null, userId), function (error) {
            if (error) return callback(error);

            things.add(userId, doc.content, doc.tags, doc.attachments, doc.externalContent, function (error, result) {
                if (error) return callback(error);
                if (!result) return callback(new Error('no result returned'));

                get(userId, result._id, userId, callback);
            });
        });
    });
}

function put(userId, thingId, content, attachments, acl, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof thingId, 'string');
    assert.strictEqual(typeof content, 'string');
    assert(Array.isArray(attachments));
    assert(Array.isArray(acl));
    assert.strictEqual(typeof callback, 'function');

    var tagObjects = extractTags(content);

    async.eachSeries(tagObjects, tags.update.bind(null, userId), function (error) {
        if (error) return callback(error);

        extractExternalContent(content, function (error, externalContent) {
            if (error) console.error('Failed to extract external content:', error);

            things.put(userId, thingId, content, tagObjects, attachments, externalContent, acl, function (error) {
                if (error) return callback(error);

                get(userId, thingId, userId, callback);
            });
        });
    });
}

function del(userId, id, callback) {
    things.del(userId, id, function (error) {
        if (error) return callback(error);
        callback(null);
    });
}

function exp(userId, callback) {
    things.getAllLean(userId, function (error, result) {
        if (error) return callback(error);
        if (!result) return (null, '');

        var out = result.map(function (thing) {
            return {
                createdAt: thing.createdAt,
                modifiedAt: thing.modifiedAt,
                content: thing.content,
                externalContent: thing.externalContent || [],
                attachments: thing.attachments || []
            };
        });

        callback(null, { things: out });
    });
}

function imp(userId, data, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    async.eachSeries(data.things, function (thing, next) {
        var tagObjects = extractTags(thing.content);

        async.eachSeries(tagObjects, tags.update.bind(null, userId), function (error) {
            if (error) return next(error);

            // older exports use strings here
            if (typeof thing.createdAt === 'string') thing.createdAt = (new Date(thing.createdAt)).getTime();
            if (typeof thing.modifiedAt === 'string') thing.modifiedAt = (new Date(thing.modifiedAt)).getTime();

            things.addFull(userId, thing.content, tagObjects, thing.attachments || [], thing.externalContent || [], thing.createdAt, thing.modifiedAt || thing.createdAt, function (error, result) {
                if (error) return next(error);
                if (!result) return next(new Error('no result returned'));

                next(null, result._id);
            });
        });
    }, callback);
}

function cleanupTags() {
    var userIds = things.getAllActiveUserIds();

    async.each(userIds, function (userId, callback) {
        things.getAllLean(userId, function (error, result) {
            if (error) return console.error(new Error(error));

            var activeTags = [];
            result.forEach(function (thing) {
                activeTags = activeTags.concat(extractTags(thing.content));
            });

            tags.get(userId, function (error, result) {
                if (error) return console.error(new Error(error));

                async.each(result, function (tag, callback) {
                    if (activeTags.indexOf(tag.name) !== -1) return callback(null);

                    console.log('Cleanup tag', tag.name);

                    tags.del(userId, String(tag._id), callback);
                }, callback);
            });
        });
    }, function (error) {
        if (error) console.error('Cleanup tags failed:', error);
    });
}

function importThings(userId, filePath, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof filePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    var attachmentFolder = path.join(config.attachmentDir, userId);
    mkdirp.sync(attachmentFolder);

    function cleanup() {
        // cleanup things.json
        safe.fs.unlinkSync(path.join(attachmentFolder, 'things.json'));

        // cleanup uploaded file
        safe.fs.unlinkSync(filePath);
    }

    var outStream = fs.createReadStream(filePath);
    var extract = tar.extract(attachmentFolder, {
        map: function (header) {
            var prefix = 'attachments/';

            if (header.name.indexOf(prefix) === 0) header.name = header.name.slice(prefix.length);

            return header;
        }
    });

    extract.on('error', function (error) {
        cleanup();

        callback(error);
    });

    outStream.on('end', function () {
        var data = safe.require(path.join(attachmentFolder, 'things.json'));

        cleanup();

        // very basic sanity check
        if (!data) return callback('content is not JSON');
        if (!Array.isArray(data.things)) return callback('content must have a "things" array');

        imp(userId, data, callback);
    });

    outStream.pipe(extract);
}

function expOldData() {
    var collection = config.db.collection('things');

    collection.find({}).toArray(function (error, result) {
        if (error) return console.error('Failed to export old data:', error);
        if (!result || result.length === 0) return;   // nothing to do

        console.log('Old data found, prepare for import');

        var tmp = result.map(function (thing) {
            return {
                createdAt: thing.createdAt,
                modifiedAt: thing.modifiedAt,
                content: thing.content,
                externalContent: thing.externalContent || [],
                attachments: thing.attachments || []
            };
        });

        var oldAttachmentFolder = '/app/data/attachments';

        // ensure the folder exists in case the user has never uploaded a file
        mkdirp.sync(oldAttachmentFolder);

        var out = tar.pack(oldAttachmentFolder, {
            map: function (header) {
                header.name = 'attachments/' + header.name;
                return header;
            }
        });

        // add the db dump
        out.entry({ name: 'things.json' }, JSON.stringify({ things: tmp }, null, 4));

        out.pipe(fs.createWriteStream('/tmp/old_data_export.tar'));

        out.on('end', function () {
            exports.hasOldData = '/tmp/old_data_export.tar';
            console.log('Old data available at %s', exports.hasOldData);
        });
    });
}

function cleanupOldData(callback) {
    var oldAttachmentFolder = '/app/data/attachments';

    // prevent from further importing
    exports.hasOldData = null;

    rimraf(oldAttachmentFolder, function (error) {
        if (error) console.error(error);

        var collections = [
            config.db.collection('things'),
            config.db.collection('publicLinks'),
            config.db.collection('tags')
        ];

        async.eachSeries(collections, function (collection, callback) {
            collection.drop(function(error) {
                if (error) console.error(error);
                callback();
            });
        }, callback);
    });
}
