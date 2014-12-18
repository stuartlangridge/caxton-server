var express = require('express'),
    app = exports.app = express(),
    bodyParser = require('body-parser'),
    pg = require('pg'),
    exphbs  = require('express-handlebars'),
    async = require('async'),
    fs = require('fs'),
    RSA = require('node-rsa'),
    request = require('request');

// load keys
var key = new RSA();
key.importKey(fs.readFileSync('private.key'));
var pubkey = new RSA();
pubkey.importKey(fs.readFileSync('public.key'));

// Create database contents table on startup
exports.dbStartup = function(dburl) {
    pg.connect(dburl, function(err, client, returnClientToPool) {
        if (err) {
            throw new Error(err);
        }
        var sqls = [
            'create table if not exists codes ' +
                '(id serial primary key, pushtoken varchar, code varchar, ' +
                'created timestamp DEFAULT now() NOT NULL)',
            'CREATE OR REPLACE FUNCTION delete_old_rows() RETURNS trigger ' +
                'LANGUAGE plpgsql AS $$ BEGIN ' +
                "DELETE FROM codes WHERE created < NOW() - INTERVAL '15 minutes';" +
                'RETURN NEW; END; $$;',
            'DROP TRIGGER IF EXISTS old_rows_gc ON codes;',
            'CREATE TRIGGER old_rows_gc AFTER INSERT ON codes ' +
                'EXECUTE PROCEDURE delete_old_rows();'
        ];
        async.eachSeries(sqls, function(sql, cb) {
            client.query(sql, function(err, result) {
                returnClientToPool();
                cb(err);
            });
        }, function(err) {
            if (err) {
                throw new Error(err);
            }
        });
    });
};

app.set('dburl', process.env.DATABASE_URL);
app.set('port', (process.env.PORT || 3000));
app.use(express.static(__dirname + '/public'));

app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

app.use(bodyParser.urlencoded({
  extended: true
}));

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.get('/', function (req, res) {
    res.render('home');
});
app.get('/bookmarklet', function (req, res) {
    res.render('bookmarklet');
});

function sendPushNotification(token, content, done) {
    console.log("requesting with token", token);
    var dict = {
        url: "https://push.ubuntu.com/notify",
        json: true,
        body: {
            appid: "org.kryogenix.caxton_caxton",
            expire_on: "2015-12-08T14:48:00.000Z",
            token: token,
            data: {
                message: content,
                notification: {
                    card: {
                        summary: content.appname,
                        body: content.message,
                        popup: true,
                        persist: true
                    },
                    sound: content.sound,
                    tag: content.tag,
                    vibrate: {
                        duration: 200,
                        pattern: (200, 100),
                        repeat: 2
                    }
                }
            }
        }
    };
    if (content.count) {
        dict.body.data.notification["emblem-counter"] = {count: content.count, visible: true};
    }
    request.post(dict, function(err, resp) {
        console.log("request done", resp.body);
        done(err);
    });
}

function unwrapPassedToken(enc, appname) {
    // the token we receive should actually be encrypted JSON {token: actualtoken}
    var dec, pushtoken;
    dec = key.decrypt(enc, 'utf8');
    dec = JSON.parse(dec);
    if (!dec.token) { throw new Error("No token entry in JSON: " + JSON.stringify(dec)); }
    if (dec.appname != appname) { throw new Error("Mismatched appname ('" + 
        appname + "' vs '" + dec.appname + "') in JSON: " + JSON.stringify(dec)); }
    return dec.token;
}

app.post('/api/getcode', function(req, res) {
    if (!req.body || !req.body.pushtoken) {
        console.log("Error getting code: incomplete request: ", req.body);
        return res.status(400).json({error: "Incomplete request"});
    }
    // Create a random easy-to-type code
    var possible = "abcdefghijklmnopqrstuvwxyz", code = "";

    for(var i=0; i < 5; i++) {
        code += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    pg.connect(app.get('dburl'), function(err, client, returnClientToPool) {
        if (err) {
            console.log("Error getting code: connection: ", err);
            return res.status(500).json({error: "Server problem"});
        }
        client.query("insert into codes (pushtoken, code) values ($1::varchar, $2::varchar)", 
            [req.body.pushtoken, code],
            function(err, result) {
            returnClientToPool();
            if (err) {
                console.log("Error getting code: insert: ", err);
                return res.status(500).json({error: "Server problem"});
            }
            console.log("Returning a code to client", code);
            res.json({code: code});
        });
    });
});

app.post('/api/gettoken', function(req, res) {
    if (!req.body || !req.body.code) {
        return res.status(400).json({error: "Incomplete request"});
    }
    if (!req.body.appname) {
        return res.status(400).json({error: "No appname provided"});
    }
    pg.connect(app.get('dburl'), function(err, client, returnClientToPool) {
        if (err) {
            console.log("Error getting code: connection: ", err);
            return res.status(500).json({error: "Server problem"});
        }
        client.query("select pushtoken from codes where code = $1::varchar", 
            [req.body.code],
            function(err, result) {
            returnClientToPool();
            if (err) {
                console.log("Error getting code: insert: ", err);
                return res.status(500).json({error: "Server problem"});
            }
            if (result.rows.length === 0) {
                return res.status(404).json({error: "no such code"});
            }
            // encrypt token with public key before sending it to client
            var enctoken = pubkey.encrypt(JSON.stringify({
                token:result.rows[0].pushtoken,
                appname: req.body.appname
            }), "base64");
            res.json({token: enctoken});
            // and remove token from DB
            client.query("delete from codes where code = $1::varchar", [req.body.code], function(err, result) {
                returnClientToPool();
            });
            // and notify the client that it's done
            sendPushNotification(result.rows[0].pushtoken, {type: "token-received", 
                code: req.body.code, appname: req.body.appname, 
                message: "App " + req.body.appname + " is now paired!"}, function() {});
        });
    });
});

app.post('/api/send', function(req, res) {
    if (!req.body || !req.body.token || !req.body.url || !req.body.appname) {
        console.log("Body missing parameters", req.body);
        return res.status(400).json({error: "Incomplete request"});
    }
    var token;
    try {
        token = unwrapPassedToken(req.body.token, req.body.appname);
    } catch(e) {
        console.log("Passed invalid token in send request", e);
        return res.status(400).json({error: "Invalid token"});
    }
    sendPushNotification(token, {url:req.body.url, appname: req.body.appname, 
        message: req.body.message || req.body.url, tag: req.body.tag || "caxton",
        sound: req.body.sound || "buzz.mp3", type: "user"}, function(err) {
        if (err) {
            console.log("Error sending push notification", e);
            return res.status(500).json({error: "Push notification failed"});
        }
        res.json({ok: "Ok"});
    });
});

if (require.main == module) {
    exports.dbStartup(app.get('dburl'));
    var server = app.listen(app.get('port'), function () {
      var host = server.address().address;
      var port = server.address().port;
      console.log('Caxton server listening at http://%s:%s', host, port);
    });
}
