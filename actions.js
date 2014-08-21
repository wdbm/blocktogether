/**
 * Script to block a list of screen names using credentials for a given user id
 */
var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    _ = require('sequelize').Utils._,
    setup = require('./setup');

var twitter = setup.twitter,
    logger = setup.logger,
    BtUser = setup.BtUser,
    UnblockedUser = setup.UnblockedUser,
    Action = setup.Action;

/**
 * Given a list of uids, enqueue them all in the Actions table.
 *
 * TODO: Once all the actions are created, this should kick off a processing run
 * for the triggering user. Need to figure out how to do Promise joins.
 *
 * @param {string} source_uid The user who wants to perform these actions.
 * @param {string[]} list A list of uids to target with the actions.
 */
function queueBlocks(source_uid, list) {
  list.map(function(sink_uid) {
    return Action.create({
      source_uid: source_uid,
      sink_uid: sink_uid,
      type: 'block'
    }).error(function(err) {
      logger.error(err);
    });
  });
}

/**
 * Find all pending block actions in the queue, validate and execute them.
 *
 * Validation is a little tricky.  We want to check whether a given
 * user is blocking the target. The relevant endpoint is friendships/lookup,
 * https://dev.twitter.com/docs/api/1.1/get/friendships/lookup.
 * That endpoint has a rate limit of 15 requests per 15 minutes, which means
 * bulk blocking would proceed very slowly if we called it once per block
 * action.
 *
 * However, friendships/lookup supports bulk querying of up to 100 users at
 * once. So we group pending actions by source_uid, then do a second query by
 * that uid to get up to 100 of their oldest pending actions.
 *
 * Note that the block endpoint can only block one user
 * at a time, but it does not appear to have a rate limit.
 *
 * When a block action is completed, set its state to DONE. When a block
 * action is cancelled because the source_uid follows the sink_uid, set its
 * state to CANCELLED_FOLLOWING.
 */
function processBlocks() {
  Action.findAll({
    where: ['status = "pending" and type = "block"'],
    group: 'source_uid',
    limit: 300
  }).error(function(err) {
    console.log(err);
  }).success(function(actions) {
    actions.forEach(function(action) {
      processActionsForUserId(action.source_uid);
    });
  })
}

/**
 * For a given user id, fetch and process pending actions.
 * @param {string} uid The uid of the user to process.
 */
function processActionsForUserId(uid) {
  BtUser
    .find({
      where: { uid: uid },
      include: [UnblockedUser]
    }).error(function(err) {
      logger.error(err);
    }).success(function(btUser) {
      if (btUser) {
        // We use a nested fetch here rather than an include because the actions
        // for a user can be quite large. The SQL generated by a BtUser.find
        // with an include statement has two problems: (1) It doesn't respect
        // the limit clause, and (2) each row returned for Actions also includes
        // the full BtUser object, which contains some long strings. This is
        // very wasteful.
        btUser.actions = btUser.getActions({
          // Out of the available pending block actions on this user,
          // pick up to 100 with the earliest updatedAt times.
          // HACK: We also look for actions that were either created just now
          // (within the last thirty seconds), or close to a multiple of 15 minutes
          // ago. This means that when an action cannot be completed right now, we
          // do not keep trying every 10 seconds (see setInterval below) and getting
          // rate limit responses. Instead, we try again in 15 minutes when the rate
          // limit window expires.
          where: ['status = "pending" and type = "block" '],
          order: 'updatedAt ASC',
          limit: 100
        }).error(function(err) {
          logger.error(err);
        }).success(function(actions) {
          if (actions) {
            processActionsForUser(btUser, actions);
          } else {
            logger.warn('No actions found for user', btUser.screen, btUser.uid);
          }
        });
      } else {
        logger.error('User not found', uid);
      }
    });
}

/**
 * Given a BtUser and a subset of that user's pending Actions, process
 * as appropriate.
 * @param {BtUser} btUser The user whose attached Actions we should process.
 */
function processActionsForUser(btUser, actions) {
  if (actions.length > 0) {
    // Now that we've got our list, send them to Twitter to see if the
    // btUser follows them.
    var sinkUids = actions.map(function(action) {
      return action.sink_uid;
    });
    blockUnlessFollowing(btUser, sinkUids, actions);
  }
}

/**
 * Given fewer that 100 sinkUids, check the following relationship between
 * sourceBtUser and those each sinkUid, and block if there is not an existing
 * follow or block relationship. Then update the Actions provided.
 *
 * @param {BtUser} sourceBtUser The user doing the blocking.
 * @param {integer[]} sinkUids A list of uids to potentially block.
 * @param {Action[]} actions The Actions to be updated based on the results.
 */
function blockUnlessFollowing(sourceBtUser, sinkUids, actions) {
  if (sinkUids.length > 100) {
    logger.error('No more than 100 sinkUids allowed. Given', sinkUids.length);
    return;
  }
  logger.debug('Checking follow status', sourceBtUser.uid,
    '--???-->', sinkUids.length, 'users');
  twitter.friendships('lookup', {
      user_id: sinkUids.join(',')
    }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
    function(err, friendships) {
      if (err) {
        logger.error('Error /friendships/lookup', err.statusCode, 'for',
          sourceBtUser.screen_name, err.data);
      } else {
        var indexedFriendships = _.indexBy(friendships, 'id_str');
        blockUnlessFollowingWithFriendships(
          sourceBtUser, indexedFriendships, actions);
      }
    });
}

/**
 * After fetching friendships results from the Twitter API, process each one,
 * one at a time, and block if appropriate. This function calls itself
 * recursively in the callback from the Twitter API, to avoid queuing up large
 * numbers of HTTP requests abruptly.
 *
 * @param{BtUser} sourceBtUser The user doing the blocking.
 * @param{Object} indexedFriendships A map from uids to friendship objects as
 *   returned by the Twitter API.
 * @param{Action[]} actions The list of actions to be performed or state
 *   transitioned.
 */
function blockUnlessFollowingWithFriendships(
    sourceBtUser, indexedFriendships, actions) {
  if (!actions || actions.length < 1) {
    return;
  }
  var next = blockUnlessFollowingWithFriendships.bind(
      undefined, sourceBtUser, indexedFriendships, actions.slice(1));
  var action = actions[0];
  var sink_uid = action.sink_uid;
  var friendship = indexedFriendships[sink_uid];
  // Decide which state to transition the Action into, if it's not going to be
  // executed.
  var newState = null;

  // If no friendship for this action was returned by /1.1/users/lookup,
  // that means the sink_uid was suspened or deactivated, so defer the Action.
  if (!friendship) {
    newState = Action.DEFERRED_TARGET_SUSPENDED;
  } else if (_.contains(friendship.connections, 'blocking')) {
    // If the sourceBtUser already blocks them, don't re-block.
    newState = Action.CANCELLED_DUPLICATE;
  } else if (_.contains(friendship.connections, 'following')) {
    // If the sourceBtUser follows them, don't block.
    newState = Action.CANCELLED_FOLLOWING;
  } else if (_.find(sourceBtUser.unblockedUsers, {sink_uid: sink_uid})) {
    // If the user unblocked the sink_uid in the past, don't re-block.
    newState = Action.CANCELLED_UNBLOCKED;
  } else if (sourceBtUser.uid === sink_uid) {
    // You cannot block yourself.
    newState = Action.CANCELLED_SELF;
  }
  // If we're cancelling, update the state of the action. It's
  // possible to have multiple pending Blocks for the same sink_uid, so
  // we have to do a forEach across the available Actions.
  if (newState) {
    setActionStatus(action, newState, next);
  } else {
    // No obstacles to blocking the sink_uid have been found, block 'em!
    // TODO: Don't kick off all these requests to Twitter
    // simultaneously; instead chain them.
    logger.debug('Creating block', sourceBtUser.screen_name,
      '--block-->', friendship.screen_name, sink_uid);
    twitter.blocks('create', {
        user_id: sink_uid,
        skip_status: 1
      }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
      function(err, results) {
        if (err) {
          logger.error('Error blocking: %j', err);
          logger.error('Error /blocks/create', err.statusCode,
            sourceBtUser.screen_name, sourceBtUser.uid,
            '--block-->', friendship.screen_name, friendship.id_str,
            err.data);
        } else {
          logger.info('Blocked ', sourceBtUser.screen_name, sourceBtUser.uid,
            '--block-->', results.screen_name, results.id_str);
          setActionStatus(action, Action.DONE, next);
        }
      });
  }
}

/**
 * Set an actions status to newState, save it, and call the `next' callback
 * regardless of success or error.
 */
function setActionStatus(action, newState, next) {
  action.status = newState;
  action.save().error(function(err) {
    logger.error(err);
    next();
  }).success(next);
}

module.exports = {
  queueBlocks: queueBlocks,
  processActionsForUserId: processActionsForUserId
};

if (require.main === module) {
  // TODO: It's possible for one run of processBlocks could take more than 10
  // seconds, in which case we wind up with multiple instances running
  // concurrently. This probably won't happen since each run only processes 100
  // items per user, but with a lot of users it could, and would lead to some
  // redundant work as each instance tried to grab work from a previous
  // instance. Figure out a way to prevent this while being robust (i.e. not
  // having to make sure every possible code path calls a finishing callback).
  processBlocks();
  setInterval(processBlocks, 70 * 1000);
}
