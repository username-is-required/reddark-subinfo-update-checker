# reddark-subinfo-update-checker

## About
A script (designed to be deployed to DigitalOcean Functions) that has been built to assist with the manual maintaining of the lists over at [reddark-subinfo](https://github.com/username-is-required/reddark-subinfo). Although the script cannot be certain if a list of subreddits needs to be modified, if conditions are met that makes this a possibility, it will open up an issue in the reddark-subinfo repository for a human maintainer to review.

The script is currently set to run every half hour.

## Enviroment variables
The following environment variables must be set:

 - `GITHUB_ACCESS_TOKEN`
 - `SPACES_KEY`
 - `SPACES_SECRET`
