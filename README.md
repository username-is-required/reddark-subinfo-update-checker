# reddark-subinfo-update-checker

## About
A script (intended for use with Google Cloud Scheduler, Google Cloud Build/Run & Google Cloud Firestore) that has been built to assist with the manual maintaining of the lists over at [reddark-subinfo](https://github.com/username-is-required/reddark-subinfo).

The script is currently set to run every two hours.

### John Oliver subs
Although the script cannot be certain if the list of John Oliver subreddits needs to be modified, if conditions are met that makes this a possibility, it will open up an issue in the reddark-subinfo repository for a human maintainer to review.

### Banned subs
The script maintains the list of banned subs completely automatically - checking to see if a sub is banned/unbanned, and updating the list as and when needed.

## Enviroment variables
The following environment variables must be set:

 - `GITHUB_ACCESS_TOKEN`
