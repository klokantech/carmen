var getSetRelevance = require('./pure/setrelevance'),
    coalesceZooms = require('./pure/coalescezooms'),
    sm = new(require('sphericalmercator'))(),
    ops = require('./util/ops'),
    mp2_14 = Math.pow(2, 14),
    mp2_28 = Math.pow(2, 28),
    queue = require('queue-async'),
    feature = require('./util/feature'),
    cleanFeature = require('./util/ops').feature;

module.exports = relevSort;

// Given that we've geocoded potential results in multiple sources, given
// arrays of `feats` and `grids` of the same length, combine matches that
// are over the same point, factoring in the zoom levels on which they
// occur.
// Calls `callback` with `(err, contexts, relevd)` in which
//
// @param `contexts` is an array of bboxes which are assigned scores
// @param `relevd` which is an object mapping place ids to places
// @param {Object} geocoder the geocoder instance
// @param {Array} feats an array of feature objects
// @param {Array} grids an array of grid objects
// @param {Array} zooms an array of zoom numbers
// @param {Function} callback
function relevSort(indexes, types, query, stats, geocoder, feats, grids, zooms, callback) {

    // Combine the scores for each match across multiple grids and zoom levels,
    // producing a mapping from `zxy` to matches
    var coalesced = coalesceZooms(grids, feats, types, zooms, indexes);

    var sets = {},
        i, j, c, l,
        feat,
        rowMemo = {},
        rows,
        relev,
        fullid;

    for (c in coalesced) {
        rows = coalesced[c];
        // Sort by db, relev such that total relev can be
        // calculated without results for the same db being summed.
        rows.sort(sortRelevReason);
        relev = getSetRelevance(query, rows);

        // A threshold here reduces results early.
        // if (relev < 0.75) continue;

        for (i = 0, l = rows.length; i < l; i++) {
            fullid = rows[i].db + '.' + rows[i].id;
            sets[fullid] = sets[fullid] || rows[i];
            rowMemo[rows[i].tmpid] = rowMemo[rows[i].tmpid] || {
                db: rows[i].db,
                id: rows[i].id,
                tmpid: rows[i].tmpid,
                relev: relev
            };
        }
    }

    var results = [],
        contexts = [],
        formatted = [],
        memo = null;

    for (j in rowMemo) {
        results.push(rowMemo[j]);
    }

    results.sort(sortByRelev);

    for (var k = 0; k < results.length; k++) {
        feat = results[k];
        if (memo === null || memo - feat.relev < 0.5) {
            memo = feat.relev;
            formatted.push(feat);
        }
    }

    results = formatted;

    stats.relevTime = +new Date() - stats.relevTime;
    stats.relevCount = results.length;

    if (!results.length) return callback(null, results);

    // Disallow more than 50 of the best results at this point.
    if (results.length > 50) results = results.slice(0, 50);

    var start = +new Date();
    var q = queue();

    results.forEach(function(term) {
        q.defer(loadResult, term);
    });

    q.awaitAll(function(err) {
        if (err) return callback(err);
        stats.contextTime = +new Date() - start;
        stats.contextCount = contexts.length;
        return callback(null, contexts, sets);
    });

    // For each result, load the feature from its Carmen index so that we can
    // then load all of the relevant contexts for that feature
    function loadResult(term, callback) {
        var cq = queue();
        var source = geocoder.indexes[term.db];
        feature.getFeature(source, term.id, featureLoaded);
        function featureLoaded(err, features) {
            if (err) return callback(err);
            for (var id in features) {
                // To exclude false positives from feature hash collisions
                // check the feature lon/lat coord and ensure it is in the
                // coalesced result set.
                // @TODO for fully accurate results, iterate through
                // coalesced[coord] for a matching feature id.
                var bbox = sm.xyz([features[id].lon, features[id].lat, features[id].lon, features[id].lat], source._geocoder.zoom);
                var coord = (source._geocoder.zoom * mp2_28) + (bbox.minX * mp2_14) + (bbox.minY);
                if (coalesced[coord]) cq.defer(function(feat, callback) {
                    geocoder._contextByFeature(cleanFeature(term.id, term.db, feat), callback);
                }, features[id]);
            }
            cq.awaitAll(contextLoaded);
        }
        function contextLoaded(err, loaded) {
            if (err) return callback(err);
            contexts.push.apply(contexts, loaded);
            callback();
        }
    }

    function sortRelevReason(a, b) {
        var ai = types.indexOf(a.db);
        var bi = types.indexOf(b.db);
        if (ai < bi) return -1;
        else if (ai > bi) return 1;
        else if (a.relev > b.relev) return -1;
        else if (a.relev < b.relev) return 1;
        else if (a.reason > b.reason) return -1;
        else if (a.reason < b.reason) return 1;
        else if (a.id < b.id) return -1;
        else if (a.id > b.id) return 1;
        return 0;
    }
}

function sortByRelev(a, b) {
    return a.relev > b.relev ? -1 :
        a.relev < b.relev ? 1 :
        a.tmpid < b.tmpid ? -1 :
        a.tmpid > b.tmpid ? 1 : 0;
}