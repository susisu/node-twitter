/**
 * Legacy helper functions
 *
 */

/**
 * Module dependencies
 */

var http = require('http');
var querystring = require('querystring');
var Cookies = require('cookies');
var streamparser = require('./parser');
var merge = require('util')._extend;

module.exports = function(Twitter) {

  /*
   * SEARCH (not API stable!)
   */
  Twitter.prototype.search = function search(q, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    if ( typeof callback !== 'function' ) {
      throw "FAIL: INVALID CALLBACK.";
    }

    var url = 'search/tweets.json';
    params = merge(params, {q:q});
    this.get(url, params, callback);
    return this;
  };


  /*
   * STREAM
   */
  Twitter.prototype.stream = function stream(method, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var stream_base = this.options.stream_base;

    // Stream type customisations
    if (method === 'user') {
      stream_base = this.options.user_stream_base;
      // Workaround for node-oauth vs. twitter commas-in-params bug
      if ( params && params.track && Array.isArray(params.track) ) {
        params.track = params.track.join(',');
      }

    } else if (method === 'site') {
      stream_base = this.options.site_stream_base;
      // Workaround for node-oauth vs. twitter double-encode-commas bug
      if ( params && params.follow && Array.isArray(params.follow) ) {
        params.follow = params.follow.join(',');
      }
    } else if (method === 'filter') {
      stream_base = this.options.filter_stream_base;
      // Workaround for node-oauth vs. twitter commas-in-params bug
      if ( params && params.track && Array.isArray(params.track) ) {
        params.track = params.track.join(',');
      }
    }


    var url = stream_base + '/' + escape(method) + '.json';

    var request = this.oauth.post(url,
      this.options.access_token_key,
      this.options.access_token_secret,
      params);

    var stream = new streamparser();
    stream.destroy = function() {
      // FIXME: should we emit end/close on explicit destroy?
      if ( typeof request.abort === 'function' )
        request.abort(); // node v0.4.0
      else
        request.socket.destroy();
    };
    stream.request = request;
    
    request.on('response', function(response) {
      stream.response = response;
      // FIXME: Somehow provide chunks of the response when the stream is connected
      // Pass HTTP response data to the parser, which raises events on the stream
      response.on('data', function(chunk) {
        stream.receive(chunk);
      });

      response.on('error', function(error) {
        stream.emit('error', error);
      });

      response.on('end', function() {
        stream.emit('end', response);
      });
    });

    request.on('error', function(error) {
      stream.emit('error', error);
    });
    request.end();

    if ( typeof callback === 'function' ) callback(stream);
    return this;
  };


  /*
   * TWITTER "O"AUTHENTICATION UTILITIES, INCLUDING THE GREAT
   * CONNECT/STACK STYLE TWITTER "O"AUTHENTICATION MIDDLEWARE
   * and helpful utilities to retrieve the twauth cookie etc.
   */
  Twitter.prototype.cookie = function cookie(req) {
    // Fetch the cookie
    var cookies = new Cookies(req, null, this.keygrip);
    return this._readCookie(cookies);
  };

  Twitter.prototype.login = function login(mount, success) {
    var self = this,
      url = require('url');

    // Save the mount point for use in gatekeeper
    this.options.login_mount = mount = mount || '/twauth';

    // Use secure cookie if forced to https and haven't configured otherwise
    if ( this.options.secure && !this.options.cookie_options.secure )
      this.options.cookie_options.secure = true;

    return function handle(req, res, next) {
      var path = url.parse(req.url, true);

      // We only care about requests against the exact mount point
      if ( path.pathname !== mount ) return next();

      // Set the oauth_callback based on this request if we don't have it
      if ( !self.oauth._authorize_callback ) {
        // have to get the entire url because this is an external callback
        // but it's only done once...
        var scheme = (req.socket.secure || self.options.secure) ? 'https://' : 'http://';
        path = url.parse(scheme + req.headers.host + req.url, true);
        self.oauth._authorize_callback = path.href;
      }

      // Fetch the cookie
      var cookies = new Cookies(req, res, self.keygrip);
      var twauth = self._readCookie(cookies);

      // We have a winner, but they're in the wrong place
      if ( twauth && twauth.user_id && twauth.access_token_secret ) {
        res.status(302).redirect( success || '/');
        res.end();
        return;

      // Returning from Twitter with oauth_token
      } else if ( path.query && path.query.oauth_token && path.query.oauth_verifier && twauth && twauth.oauth_token_secret ) {
        self.oauth.getOAuthAccessToken(
          path.query.oauth_token,
          twauth.oauth_token_secret,
          path.query.oauth_verifier,
        function(error, access_token_key, access_token_secret, params) {
          // FIXME: if we didn't get these, explode
          var user_id = (params && params.user_id) || null,
            screen_name = (params && params.screen_name) || null;

          if ( error ) {
            // FIXME: do something more intelligent
            return next(500);
          } else {
            // store access token
            self.options.access_token_key = twauth.access_token_key;
            self.options.access_token_secret = twauth.access_token_secret;
            cookies.set(self.options.cookie, JSON.stringify({
              user_id: user_id,
              screen_name: screen_name,
              access_token_key: access_token_key,
              access_token_secret: access_token_secret
            }), self.options.cookie_options);
            res.writeHead(302, {'Location': success || '/'});
            res.end();
            return;
          }
        });

      // Begin OAuth transaction if we have no cookie or access_token_secret
      } else if ( !(twauth && twauth.access_token_secret) ) {
        self.oauth.getOAuthRequestToken(
        function(error, oauth_token, oauth_token_secret, oauth_authorize_url, params) {
          if ( error ) {
            // FIXME: do something more intelligent
            return next(500);
          } else {
            cookies.set(self.options.cookie, JSON.stringify({
              oauth_token: oauth_token,
              oauth_token_secret: oauth_token_secret
            }), self.options.cookie_options);
            res.writeHead(302, {
              'Location': self.options.authorize_url + '?' +
                  querystring.stringify({oauth_token: oauth_token})
            });
            res.end();
            return;
          }
        });

      // Broken cookie, clear it and return to originating page
      // FIXME: this is dumb
      } else {
        cookies.set(self.options.cookie, null, self.options.cookie_options);
        res.writeHead(302, {'Location': mount});
        res.end();
        return;
      }
    };
  };

  Twitter.prototype.gatekeeper = function gatekeeper(options) {
    var self = this,
      mount = this.options.login_mount || '/twauth',
          defaults = {
              failureRedirect: null
          };
      options = merge(defaults, options);

    return function(req, res, next) {
      var twauth = self.cookie(req);

      // We have a winner
      if ( twauth && twauth.user_id && twauth.access_token_secret ) {
        self.options.access_token_key = twauth.access_token_key;
        self.options.access_token_secret = twauth.access_token_secret;
        return next();
      }

      if (options.failureRedirect) {
          res.redirect(options.failureRedirect);
      } else {
          res.writeHead(401, {}); // {} for bug in stack
          res.end([
              '<html><head>',
              '<meta http-equiv="refresh" content="1;url=' + mount + '">',
              '</head><body>',
              '<h1>Twitter authentication required.</h1>',
              '</body></html>'
          ].join(''));
      }
    };
  };


  /*
   * CONVENIENCE FUNCTIONS (not API stable!)
   */

  // Timeline resources

  Twitter.prototype.getHomeTimeline = function getHomeTimeline(params, callback) {
    var url = '/statuses/home_timeline.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getMentions = function getMentions(params, callback) {
    var url = '/statuses/mentions.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetedByMe = function getRetweetedByMe(params, callback) {
    var url = '/statuses/retweeted_by_me.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetedToMe = function getRetweetedToMe(params, callback) {
    var url = '/statuses/retweeted_to_me.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetsOfMe = function getRetweetsOfMe(params, callback) {
    var url = '/statuses/retweets_of_me.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getUserTimeline = function getUserTimeline(params, callback) {
    var url = '/statuses/user_timeline.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetedToUser = function getRetweetedToUser(params, callback) {
    var url = '/statuses/retweeted_to_user.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetedByUser = function getRetweetedByUser(params, callback) {
    var url = '/statuses/retweeted_by_user.json';
    this.get(url, params, callback);
    return this;
  };

  // Tweets resources

  Twitter.prototype.showStatus = function showStatus(id, callback) {
    var url = '/statuses/show/' + escape(id) + '.json';
    this.get(url, null, callback);
    return this;
  };

  Twitter.prototype.getStatus = Twitter.prototype.showStatus;

  Twitter.prototype.updateStatus = function updateStatus(text, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var url = '/statuses/update.json';
    var defaults = {
      status: text,
      include_entities: 1
    };
    params = merge(defaults, params);
    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.destroyStatus = function destroyStatus(id, callback) {
    var url = '/statuses/destroy/' + escape(id) + '.json';
    this.post(url, null, callback);
    return this;
  };

  Twitter.prototype.deleteStatus = Twitter.prototype.destroyStatus;

  Twitter.prototype.retweetStatus = function retweetStatus(id, callback) {
    var url = '/statuses/retweet/' + escape(id) + '.json';
    this.post(url, null, callback);
    return this;
  };

  Twitter.prototype.getRetweets = function getRetweets(id, params, callback) {
    var url = '/statuses/retweets/' + escape(id) + '.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetedBy = function getRetweetedBy(id, params, callback) {
    var url = '/statuses/' + escape(id) + '/retweeted_by.json';
    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.getRetweetedByIds = function getRetweetedByIds(id, params, callback) {
    var url = '/statuses/' + escape(id) + '/retweeted_by/ids.json';
    this.post(url, params, callback);
    return this;
  };

  // User resources

  Twitter.prototype.showUser = function showUser(id, callback) {
    //  NOTE: params with commas b0rk between node-oauth and twitter
    //        https://github.com/ciaranj/node-oauth/issues/7
    var url = '/users/show.json';

    var params = {};

    if (typeof id === 'object' && id !== null) {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else
      params.user_id = id;

    this.get(url, params, callback);
    return this;
  }
  Twitter.prototype.lookupUser = Twitter.prototype.showUser;

  Twitter.prototype.lookupUsers = function lookupUsers(ids, callback) {
    var url = '/users/lookup.json';

    var params = {};

    params.user_id = JSON.stringify(ids);

    this.get(url, params, callback);
    return this;
  }

  Twitter.prototype.searchUser = function searchUser(q, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var url = '/users/search.json';
    params = merge(params, {q:q});
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.searchUsers = Twitter.prototype.searchUser;

  // FIXME: users/suggestions**

  Twitter.prototype.userProfileImage = function userProfileImage(id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    } else if (typeof params === 'string') {
      params = { size: params };
    }

    var url = '/users/profile_image/' + escape(id) + '.json?' + querystring.stringify(params);

    // Do our own request, so we can return the 302 location header
    var request = this.oauth.get(this.options.rest_base + url,
      this.options.access_token_key,
      this.options.access_token_secret);
    request.on('response', function(response) {
      // return the location or an HTTP error
      callback(response.headers.location || new Error('HTTP Error ' +
          response.statusCode + ': ' +
          http.STATUS_CODES[response.statusCode]));
    });
    request.end();

    return this;
  };

  // FIXME: statuses/friends, statuses/followers

  // Trends resources

  Twitter.prototype.getTrends = function getTrends(callback) {
    var url = '/trends.json';
    this.get(url, null, callback);
    return this;
  };

  Twitter.prototype.getCurrentTrends = function getCurrentTrends(params, callback) {
    var url = '/trends/current.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getDailyTrends = function getDailyTrends(params, callback) {
    var url = '/trends/daily.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getDailyTrends = function getDailyTrends(params, callback) {
    var url = '/trends/weekly.json';
    this.get(url, params, callback);
    return this;
  };

  // Local Trends resources

  // List resources

  Twitter.prototype.getLists = function getLists(id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var defaults = {key:'lists'};

    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      defaults.screen_name = id;
    else
      defaults.user_id = id;

    params = merge(defaults, params);

    var url = '/lists.json';
    this._getUsingCursor(url, params, callback);
    return this;
  };

  Twitter.prototype.getListMemberships = function getListMemberships(id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var defaults = {key:'lists'};

    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      defaults.screen_name = id;
    else
      defaults.user_id = id;
    params = merge(defaults, params);

    var url = '/lists/memberships.json';
    this._getUsingCursor(url, params, callback);
    return this;
  };

  Twitter.prototype.getListSubscriptions = function getListSubscriptions(id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var defaults = {key:'lists'};
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      defaults.screen_name = id;
    else
      defaults.user_id = id;
    params = merge(defaults, params);

    var url = '/lists/subscriptions.json';
    this._getUsingCursor(url, params, callback);
    return this;
  };

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.showList = function showList(screen_name, list_id, callback) {
    var url = '/' + escape(screen_name) + '/lists/' + escape(list_id) + '.json';
    this.get(url, null, callback);
    return this;
  };

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.getListTimeline = function getListTimeline(screen_name, list_id, params, callback) {
    var url = '/' + escape(screen_name) + '/lists/' + escape(list_id) + '/statuses.json';
    this.get(url, params, callback);
    return this;
  };
  Twitter.prototype.showListStatuses = Twitter.prototype.getListTimeline;

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.createList = function createList(screen_name, list_name, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var url = '/' + escape(screen_name) + '/lists.json';
    params = merge(params, {name:list_name});
    this.post(url, params, callback);
    return this;
  };

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.updateList = function updateList(screen_name, list_id, params, callback) {
    var url = '/' + escape(screen_name) + '/lists/' + escape(list_id) + '.json';
    this.post(url, params, callback);
    return this;
  };

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.deleteList = function deleteList(screen_name, list_id, callback) {
    var url = '/' + escape(screen_name) + '/lists/' + escape(list_id) + '.json?_method=DELETE';
    this.post(url, null, callback);
    return this;
  };

  Twitter.prototype.destroyList = Twitter.prototype.deleteList;

  // List Members resources

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.getListMembers = function getListMembers(screen_name, list_id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var url = '/' + escape(screen_name) + '/' + escape(list_id) + '/members.json';
    params = merge(params, {key:'users'});
    this._getUsingCursor(url, params, callback);
    return this;
  };

  // FIXME: the rest of list members

  // List Subscribers resources

  // FIXME: Uses deprecated Twitter lists API
  Twitter.prototype.getListSubscribers = function getListSubscribers(screen_name, list_id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var url = '/' + escape(screen_name) + '/' + escape(list_id) + '/subscribers.json';
    params = merge(params, {key:'users'});
    this._getUsingCursor(url, params, callback);
    return this;
  };

  // FIXME: the rest of list subscribers

  // Direct Messages resources

  Twitter.prototype.getDirectMessages = function getDirectMessages(params, callback) {
    var url = '/direct_messages.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getDirectMessagesSent = function getDirectMessagesSent(params, callback) {
    var url = '/direct_messages/sent.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getSentDirectMessages = Twitter.prototype.getDirectMessagesSent;

  Twitter.prototype.newDirectMessage = function newDirectMessage(id, text, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var defaults = {
      text: text,
      include_entities: 1
    };
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      defaults.screen_name = id;
    else
      defaults.user_id = id;
    params = merge(defaults, params);

    var url = '/direct_messages/new.json';
    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.updateDirectMessage = Twitter.prototype.sendDirectMessage = Twitter.prototype.newDirectMessage;

  Twitter.prototype.destroyDirectMessage = function destroyDirectMessage(id, callback) {
    var url = '/direct_messages/destroy/' + escape(id) + '.json?_method=DELETE';
    this.post(url, null, callback);
    return this;
  };

  Twitter.prototype.deleteDirectMessage = Twitter.prototype.destroyDirectMessage;

  // Friendship resources

  Twitter.prototype.createFriendship = function createFriendship(id, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = null;
    }

    var defaults = {
      include_entities: 1
    };
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      defaults.screen_name = id;
    else
      defaults.user_id = id;
    params = merge(defaults, params);

    var url = '/friendships/create.json';
    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.destroyFriendship = function destroyFriendship(id, callback) {
    if (typeof id === 'function') {
      callback = id;
      id = null;
    }

    var params = {
      include_entities: 1
    };
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else
      params.user_id = id;

    var url = '/friendships/destroy.json?_method=DELETE';
    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.deleteFriendship = Twitter.prototype.destroyFriendship;

  // Only exposing friendships/show instead of friendships/exist

  Twitter.prototype.showFriendship = function showFriendship(source, target, callback) {
    var params = {};

    if (typeof source === 'object') {
      for(var source_property in source) {
        params[source_property] = source[source_property];
      }
    }
    else if (typeof source === 'string')
      params.source_screen_name = source;
    else
      params.source_id = source;

    if (typeof target === 'object') {
      for(var target_property in target) {
        params[target_property] = target[target_property];
      }
    }
    else if (typeof target === 'string')
      params.target_screen_name = target;
    else
      params.target_id = target;

    var url = '/friendships/show.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.incomingFriendship = function incomingFriendship(callback) {
    var url = '/friendships/incoming.json';
    this._getUsingCursor(url, {key:'ids'}, callback);
    return this;
  };

  Twitter.prototype.incomingFriendships = Twitter.prototype.incomingFriendship;

  Twitter.prototype.outgoingFriendship = function outgoingFriendship(callback) {
    var url = '/friendships/outgoing.json';
    this._getUsingCursor(url, {key:'ids'}, callback);
    return this;
  };

  Twitter.prototype.outgoingFriendships = Twitter.prototype.outgoingFriendship;

  // Friends and Followers resources

  Twitter.prototype.getFriendsIds = function getFriendsIds(id, callback) {
    if (typeof id === 'function') {
      callback = id;
      id = null;
    }
    var params = {};
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else if (typeof id === 'number')
      params.user_id = id;

    params.key = 'ids';

    var url = '/friends/ids.json';
    this._getUsingCursor(url, params, callback);
    return this;
  };

  Twitter.prototype.getFollowersIds = function getFollowersIds(id, callback) {
    if (typeof id === 'function') {
      callback = id;
      id = null;
    }

    var params = {};

    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else if (typeof id === 'number')
      params.user_id = id;

    params.key = 'ids';

    var url = '/followers/ids.json';
    this._getUsingCursor(url, params, callback);
    return this;
  };

  // Account resources

  Twitter.prototype.verifyCredentials = function verifyCredentials(callback) {
    var url = '/account/verify_credentials.json';
    this.get(url, null, callback);
    return this;
  };

  Twitter.prototype.rateLimitStatus = function rateLimitStatus(callback) {
    var url = '/application/rate_limit_status.json';
    this.get(url, null, callback);
    return this;
  };

  Twitter.prototype.updateProfile = function updateProfile(params, callback) {
    // params: name, url, location, description
    var defaults = {
      include_entities: 1
    };
    params = merge(defaults, params);

    var url = '/account/update_profile.json';
    this.post(url, params, callback);
    return this;
  };

  // FIXME: Account resources section not complete

  // Favorites resources

  Twitter.prototype.getFavorites = function getFavorites(params, callback) {
    var url = '/favorites/list.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.createFavorite = function createFavorite(params, callback) {
    var url = '/favorites/create.json';
    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.favoriteStatus = Twitter.prototype.createFavorite;

  Twitter.prototype.destroyFavorite = function destroyFavorite(id, params, callback) {
    var url = '/favorites/destroy.json';

      if(typeof params === 'function') {
          callback = params;
          params = null;
      }

      var defaults = {};

      if(typeof id === 'object') {
          params = id;
      }
      else
          defaults.id = id;

      params = merge(defaults, params);

    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.deleteFavorite = Twitter.prototype.destroyFavorite;

  // Notification resources

  // Block resources

  Twitter.prototype.createBlock = function createBlock(id, callback) {
    var url = '/blocks/create.json';

    var params = {};
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else
      params.user_id = id;

    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.blockUser = Twitter.prototype.createBlock;

  Twitter.prototype.destroyBlock = function destroyBlock(id, callback) {
    var url = '/blocks/destroy.json';

    var params = {};
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else
      params.user_id = id;

    this.post(url, params, callback);
    return this;
  };

  Twitter.prototype.unblockUser = Twitter.prototype.destroyBlock;

  Twitter.prototype.blockExists = function blockExists(id, callback) {
    var url = '/blocks/exists.json';

    var params = {};
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else
      params.user_id = id;

    this.get(url, params, null, callback);
    return this;
  };

  Twitter.prototype.isBlocked = Twitter.prototype.blockExists;

  // FIXME: blocking section not complete (blocks/blocking + blocks/blocking/ids)

  // Spam Reporting resources

  Twitter.prototype.reportSpam = function reportSpam(id, callback) {
    var url = '/report_spam.json';

    var params = {};
    if (typeof id === 'object') {
      params = id;
    }
    else if (typeof id === 'string')
      params.screen_name = id;
    else
      params.user_id = id;

    this.post(url, params, callback);
    return this;
  };

  // Saved Searches resources

  Twitter.prototype.savedSearches = function savedSearches(callback) {
    var url = '/saved_searches.json';
    this.get(url, null, callback);
    return this;
  };

  Twitter.prototype.showSavedSearch = function showSavedSearch(id, callback) {
    var url = '/saved_searches/' + escape(id) + '.json';
    this.get(url, null, callback);
    return this;
  };

  Twitter.prototype.createSavedSearch = function createSavedSearch(query, callback) {
    var url = '/saved_searches/create.json';
    this.post(url, {query: query}, callback);
    return this;
  };
  Twitter.prototype.newSavedSearch =
    Twitter.prototype.createSavedSearch;

  Twitter.prototype.destroySavedSearch = function destroySavedSearch(id, callback) {
    var url = '/saved_searches/destroy/' + escape(id) + '.json?_method=DELETE';
    this.post(url, null, callback);
    return this;
  };
  Twitter.prototype.deleteSavedSearch =
    Twitter.prototype.destroySavedSearch;

  // OAuth resources

  // Geo resources

  Twitter.prototype.geoSearch = function geoSearch(params, callback) {
    var url = '/geo/search.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.geoSimilarPlaces = function geoSimilarPlaces(lat, lng, name, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = {};
    } else if (typeof params !== 'object') {
      params = {};
    }

    if (typeof lat !== 'number' || typeof lng !== 'number' || !name) {
      callback(new Error('FAIL: You must specify latitude, longitude (as numbers) and name.'));
    }

    var url = '/geo/similar_places.json';
    params.lat = lat;
    params.long = lng;
    params.name = name;
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.geoReverseGeocode = function geoReverseGeocode(lat, lng, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = {};
    } else if (typeof params !== 'object') {
      params = {};
    }

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      callback(new Error('FAIL: You must specify latitude and longitude as numbers.'));
    }

    var url = '/geo/reverse_geocode.json';
    params.lat = lat;
    params.long = lng;
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.geoGetPlace = function geoGetPlace(place_id, callback) {
    var url = '/geo/id/' + escape(place_id) + '.json';
    this.get(url, callback);
    return this;
  };

  // Legal resources

  // Help resources

  // Streamed Tweets resources

  // Search resources

  // Deprecated resources

  Twitter.prototype.getPublicTimeline = function getPublicTimeline(params, callback) {
    var url = '/statuses/public_timeline.json';
    this.get(url, params, callback);
    return this;
  };

  Twitter.prototype.getFriendsTimeline = function getFriendsTimeline(params, callback) {
    var url = '/statuses/friends_timeline.json';
    this.get(url, params, callback);
    return this;
  };


  /*
   * INTERNAL UTILITY FUNCTIONS
   */

  Twitter.prototype._getUsingCursor = function _getUsingCursor(url, params, callback) {
    var key,
      result = [],
      self = this;

    params = params || {};
    key = params.key || null;

    // if we don't have a key to fetch, we're screwed
    if (!key)
      callback(new Error('FAIL: Results key must be provided to _getUsingCursor().'));
    delete params.key;

    // kick off the first request, using cursor -1
    params = merge(params, {cursor:-1});
    this.get(url, params, fetch);

    function fetch(data) {
      // FIXME: what if data[key] is not a list?
      if (data[key]) result = result.concat(data[key]);

      if (data.next_cursor_str === '0') {
        callback(result);
      } else {
        params.cursor = data.next_cursor_str;
        self.get(url, params, fetch);
      }
    }

    return this;
  };

  Twitter.prototype._readCookie = function(cookies) {
    // parse the auth cookie
    try {
      return JSON.parse(cookies.get(this.options.cookie));
    } catch (error) {
      return null;
    }
  };

  return Twitter;

}
