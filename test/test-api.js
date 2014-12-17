var request = require('supertest'),
    pg = require('pg'),
    rewire = require('rewire'),
    server = rewire('../index'),
    should = require('should'),
    RSA = require('node-rsa'),
    fs = require("fs");

describe('API',function() {

    var key = new RSA();
    key.importKey(fs.readFileSync('private.key'));
    // strictly can get this from the private key but it tests the pubkey file is valid
    var pubkey = new RSA();
    pubkey.importKey(fs.readFileSync('public.key'));

    before(function(done) {
        server.app.set('dburl', process.env.DATABASE_URL);
        server.dbStartup(process.env.DATABASE_URL);
        done();
    });

    it('should fail to get a code without parameters', function(done) {
        request(server.app).post("/api/getcode")
            .expect(400, done);
    });
    it('should work with parameters', function(done) {
        var pushtoken = "push" + Math.random();
        request(server.app).post("/api/getcode")
            .type('form')
            .send({ pushtoken: pushtoken })
            .expect(200)
            .end(function(err, res) {
                should.not.exist(err);
                res.body.should.have.property('code');
                // now confirm that token is in the database
                pg.connect(server.app.get('dburl'), function(err, client, returnClientToPool) {
                    should.not.exist(err);
                    client.query("select code from codes where pushtoken = $1::varchar", 
                    [pushtoken],
                    function(err, results) {
                        should.not.exist(err);
                        returnClientToPool();
                        if (err) { throw new Error(err); }
                        results.rows.length.should.equal(1);
                        results.rows[0].should.have.property('code');
                        results.rows[0].code.should.equal(res.body.code);
                        done();
                });
            });
        });
    });
    it('should fail to get a token without parameters', function(done) {
        request(server.app).post("/api/gettoken")
            .expect(400, done);
    });
    it("should complain when passed an invalid code", function(done) {
        request(server.app).post("/api/gettoken")
            .type("form")
            .send({code: "no sirree"})
            .send({appname: "1"})
            .expect(404, done);
    });
    it("should fail to get a token when no app id is provided", function(done) {
        var pushtoken = "push" + Math.random();
        request(server.app).post("/api/getcode")
            .type('form')
            .send({ pushtoken: pushtoken })
            .expect(200)
            .end(function(err, res) {
                should.not.exist(err);
                request(server.app).post("/api/gettoken")
                    .type("form")
                    .send({code: res.body.code})
                    .expect(400)
                    .end(function(err, res) {
                        should.not.exist(err);
                        res.should.have.property("body");
                        res.body.should.have.property("error");
                        res.body.error.should.equal("No appname provided");
                        done();
                });
            });
    });
    it("should get a token when passed a correct code", function(done) {
        var pushtoken = "push" + Math.random();
        request(server.app).post("/api/getcode")
            .type('form')
            .send({ pushtoken: pushtoken })
            .expect(200)
            .end(function(err, res) {
                should.not.exist(err);
                request(server.app).post("/api/gettoken")
                    .type("form")
                    .send({code: res.body.code, appname: "test-appname!"})
                    .expect(200)
                    .end(function(err, res) {
                        should.not.exist(err);
                        res.should.have.property("body");
                        res.body.should.have.property("token");
                        var dec = JSON.parse(key.decrypt(res.body.token, "utf8"));
                        dec.should.have.property("token");
                        dec.token.should.equal(pushtoken);
                        dec.should.have.property("appname");
                        dec.appname.should.equal("test-appname!");
                        done();
                });
            });
    });
    it("should fail sends with no parameters", function(done) {
        request(server.app).post("/api/send")
            .expect(400, done);
    });
    it("should fail sends with an invalid token", function(done) {
        request(server.app).post("/api/send")
            .type("form")
            .send({token: "no sirree", url: "no"})
            .expect(400, done);
    });
    it("should fail sends with no url", function(done) {
        request(server.app).post("/api/send")
            .type("form")
            .send({token: pubkey.encrypt(JSON.stringify({token:"testtoken"}), "base64")})
            .send({appname: "name"})
            .expect(400, done);
    });
    it("should fail sends with no appname", function(done) {
        request(server.app).post("/api/send")
            .type("form")
            .send({token: pubkey.encrypt(JSON.stringify({token:"testtoken"}), "base64")})
            .expect(400, done);
    });
    it("should fail requests where appname in the token is not the passed appname", function(done) {
        var passedtoken = "testtoken",
            passedurl = "http://example.com",
            called = false;
        request(server.app).post("/api/send")
            .type("form")
            .send({token: pubkey.encrypt(JSON.stringify({token:passedtoken, appname:"1"}), "base64")})
            .send({url: passedurl})
            .send({appname: "2"})
            .expect(400, done);
    });
    it("should make a request when given a valid token", function(done) {
        var passedtoken = "testtoken",
            passedurl = "http://example.com",
            appname = "test-appname",
            called = false;
        server.__set__("sendPushNotification", function(token, content, cb) {
            token.should.equal(passedtoken);
            content.should.have.property("url");
            content.url.should.equal(passedurl);
            content.should.have.property("message");
            content.message.should.equal(passedurl);
            content.should.have.property("appname");
            content.appname.should.equal(appname);
            called = true;
            cb();
        });
        request(server.app).post("/api/send")
            .type("form")
            .send({token: pubkey.encrypt(JSON.stringify({token:passedtoken, appname: appname}), "base64")})
            .send({url: passedurl})
            .send({appname: appname})
            .expect(200, function(err) {
                called.should.equal(true);
                done();
            });
    });
    it("should make a request with a message when given a valid token", function(done) {
        var passedtoken = "testtoken",
            passedurl = "http://example.com",
            appname = "test-appname",
            message = "this is the message",
            tag = "atag",
            sound = "b2.mp3",
            called = false;
        server.__set__("sendPushNotification", function(token, content, cb) {
            token.should.equal(passedtoken);
            content.should.have.property("url");
            content.url.should.equal(passedurl);
            content.should.have.property("message");
            content.message.should.equal(message);
            content.should.have.property("appname");
            content.appname.should.equal(appname);
            content.should.have.property("tag");
            content.tag.should.equal(tag);
            content.should.have.property("sound");
            content.sound.should.equal(sound);
            called = true;
            cb();
        });
        request(server.app).post("/api/send")
            .type("form")
            .send({token: pubkey.encrypt(JSON.stringify({token:passedtoken, appname: appname}), "base64")})
            .send({url: passedurl})
            .send({appname: appname})
            .send({message: message})
            .send({sound: sound})
            .send({tag: tag})
            .expect(200, function(err) {
                called.should.equal(true);
                done();
            });
    });
    it("should get a token and use it to send correctly", function(done) {
        var pushtoken = "push" + Math.random(),
            passedurl = "http://example.com",
            appname = "this is the app",
            sendtoken,
            called = false;
        server.__set__("sendPushNotification", function(token, content, cb) {
            content.should.have.property("url");
            content.url.should.equal(passedurl);
            content.should.have.property("appname");
            content.appname.should.equal(appname);
            token.should.equal(pushtoken);
            called = true;
            cb();
        });
        request(server.app).post("/api/getcode")
            .type('form')
            .send({ pushtoken: pushtoken })
            .expect(200)
            .end(function(err, res) {
                should.not.exist(err);
                request(server.app).post("/api/gettoken")
                    .type("form")
                    .send({code: res.body.code, appname: appname})
                    .expect(200)
                    .end(function(err, res) {
                        should.not.exist(err);
                        sendtoken = res.body.token;
                        request(server.app).post("/api/send")
                            .type("form")
                            .send({token: sendtoken, url: passedurl, appname: appname})
                            .expect(200, function(err) {
                                called.should.equal(true);
                                done();
                        });
                });
            });
    });
});
