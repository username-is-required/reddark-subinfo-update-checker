//const { performance } = require('perf_hooks');
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const { Octokit } = require("@octokit/core");
const { Firestore } = require("@google-cloud/firestore");
const request = require("./requests.js");


const octokit = new Octokit({
    auth: process.env.GITHUB_ACCESS_TOKEN
});

const firestore = new Firestore();

const FIRESTORE_COLLECTION = "subinfo-update-checker";
const FIRESTORE_FIELDS = {
    STICKIED_POSTS_NUMBER: "stickied-posts",
    STICKIED_1: "stickied-1",
    STICKIED_2: "stickied-2"
};


// helper function to wait for some time
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// helper function to read a file and return the data
async function getFileContents(path) {
    try {
        let fileHandle = await fsPromises.open(path);
        let fileData = await fileHandle.readFile();
        fileHandle.close();
        
        return fileData.toString()
    } catch (err) {
        console.log("Error occurred when reading file " + path + ": " + err);
        console.log("Exiting process");
        process.exit(1);
    }
}

async function fetchValidJsonData(url) {
    let data = await request.httpsGet(url);
    
    try {
        data = JSON.parse(data);
    } catch (err) {
        console.log(url + ": Request errored (bad JSON) [will retry] - " + url);
        
        // now we wait for 5 seconds and try it again
        await wait(5000);
        data = await fetchValidJsonData(url);
    }
    
    return data;
}

async function getParticipatingSubsList() {
    let subs = [];
    
    let data = await fetchValidJsonData("/r/ModCoord/wiki/index.json");
    let text = data.data.content_md;
    let lines = text.split("\n");
    
    for (let line of lines) {
        if (line.startsWith("r/")) {
            let subName = line.trim();
            if (subName.slice(-1) == "/") subName = subName.slice(0, -1);
            // exclude a single nonexistent sub that seems to be on the list for some reason
            if (subName != "r/speziscool") subs.push(subName);
        }
    }

    return subs;
}

async function getSubData(subName) {
    let subData = {};
    
    let data = await fetchValidJsonData("/" + subName + ".json");
    
    try {
        if (typeof (data['message']) != "undefined" && data['error'] == 500) {
            throw new Error("500");
        }

        subData = data;
    } catch (err) {
        console.log("/" + subName + ".json: Request to Reddit errored (will retry in 5s) - " + err);
        
        // now wait for 5s and try again
        await wait(5000);
        subData = await getSubData(subName);
    }

    return subData;
}

function getSubFirestoreDocRef(subName) {
    return firestore.collection(FIRESTORE_COLLECTION)
        .doc(subName.substring(2));
}

async function getPrevStickiedPosts(subName) {
    let doc = getSubFirestoreDocRef(subName);
    doc = await doc.get();

    if (!doc.exists) return null;

    doc = doc.data();
    
    let prevStickiedPostsText = [];

    let prevNumOfStickiedPosts =
        doc[FIRESTORE_FIELDS.STICKIED_POSTS_NUMBER];
    
    for (let i = 0; i < prevNumOfStickiedPosts; i++) {
        let postText = doc[FIRESTORE_FIELDS["STICKIED_" + (i+1)]];
        prevStickiedPostsText.push(postText);
    }

    return prevStickiedPostsText;
}

async function saveStickiedPosts(subName, stickiedPosts) {
    if (stickiedPosts.length > 2) throw new Error("cannot be more than 2 stickied posts to save");

    let doc = getSubFirestoreDocRef(subName);

    let data = {};

    data[FIRESTORE_FIELDS.STICKIED_POSTS_NUMBER] = stickiedPosts.length;
    
    for (let i = 0; i < stickiedPosts.length; i++) {
        data[FIRESTORE_FIELDS["STICKIED_" + (i+1)]] = stickiedPosts[i].selftext;
    }
    
    let result = await doc.set(data, { merge: false });
    return result;
}

async function createGithubIssue(title, body) {
    let result;
    
    try {
        result = await octokit.request('POST /repos/{owner}/{repo}/issues', {
            owner: "username-is-required",
            repo: "reddark-subinfo",
            title: title,
            body: body,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
    } catch (err) {
        console.log("Error creating GitHub issue. Will retry in 10s - " + err);

        await wait(10000);
        // try again
        result = await createGithubIssue(title, body);
    }

    return result;
}

async function createGithubAdditionIssue(subName) {
    let issueTemplatePath = path.join(__dirname, "template-issues", "potential-addition.md");
    let issueTemplate = await getFileContents(issueTemplatePath);
    subName = subName.toLowerCase();
    
    let title = "🤖 possible new johnoliver sub: " + subName;
    let body = issueTemplate.replaceAll("%subname%", subName);
    
    let result = await createGithubIssue(title, body);
    return result;
}

async function createGithubRemovalIssue(subName) {
    let issueTemplatePath = path.join(__dirname, "template-issues", "potential-removal.md");
    let issueTemplate = await getFileContents(issueTemplatePath);
    subName = subName.toLowerCase();
    
    let title = "🤖 possible johnoliver sub removal: " + subName;
    let body = issueTemplate.replaceAll("%subname%", subName);

    let result = await createGithubIssue(title, body);
return result;
}

async function processBannedSubChanges(bannedSubsList, bannedSubChanges) {
    // any changes?
    if (
        bannedSubChanges.subsToAdd.length == 0
        && bannedSubChanges.subsToRemove.length == 0
    ) {
        console.log("No banned sub changes to process");
        return;
    }
    
    let commitMessage = "🤖 automatically updating `banned-subs.json`";
    
    commitMessage += "\n\nsubs added:";
    for (let subToAdd of bannedSubChanges.subsToAdd) {
        let subName = subToAdd.toLowerCase();
        bannedSubsList.push(subName);
        commitMessage += "\n - " + subName;
    }
    if (bannedSubChanges.subsToAdd.length == 0) commitMessage += " none";

    commitMessage += "\n\nsubs removed:";
    for (let subToRemove of bannedSubChanges.subsToRemove) {
        let subName = subToRemove.toLowerCase();
        
        let subIndex = bannedSubsList.indexOf(subName);
        
        if (subIndex == -1) {
            console.log(subToRemove + ": on list to remove from banned list, but not found on banned list");
            console.log("Exiting process");
            process.exit(1);
        }
        
        bannedSubsList.splice(subIndex, 1);
        commitMessage += "\n - " + subName;
    }
    if (bannedSubChanges.subsToRemove.length == 0) commitMessage += " none";

    commitMessage += "\n";
    
    // convert to json and upload updated list to github (if any changes)
    let bannedSubsListJson = JSON.stringify({
        bannedSubs: bannedSubsList
    }, null, 4);
    
    let result;
    
    try {
         result = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner: 'username-is-required',
            repo: 'reddark-subinfo',
            path: 'banned-subs.json',
            message: commitMessage,
            content: Buffer.from(bannedSubsListJson).toString("base64"),
            sha: idkWtfThisGoesHere, // fix
            headers: {
               'X-GitHub-Api-Version': '2022-11-28'
            }
        });
    } catch (err) {
        console.log("Error updating banned subs list");
        console.log(err);
        console.log("Exiting process");
        process.exit(1);
    }
    
    console.log("Uploaded updated banned subs list to GitHub, commit " + commitRef);
    
    return result;
}

async function main() {
    console.log("** Started function **");

    console.log("Getting list of participating subs");
    let subNames = await getParticipatingSubsList();
    
    console.log("Getting list of currently recorded banned subs");
    let bannedSubs = await fetchValidJsonData("https://raw.githubusercontent.com/username-is-required/reddark-subinfo/main/banned-subs.json");
    bannedSubs = bannedSubs.bannedSubs;
    
    console.log("Getting list of currently johnoliverified subs");
    let johnOliverSubs = await fetchValidJsonData("https://raw.githubusercontent.com/username-is-required/reddark-subinfo/main/john-oliver-subs.json");
    johnOliverSubs = johnOliverSubs.johnOliverSubs;
    
    let subPromises = [];

    let bannedSubChanges = {
        subsToAdd: [],
        subsToRemove: []
    };
    
    console.log("Looping over participating subs");
    for (let subName of subNames) {
        // is the sub already part of the john oliver cult?
        let subAlreadyJohnOlivered = johnOliverSubs.includes(subName.toLowerCase());
        
        // is the sub already recorded as being banned?
        let subRecordedAsBanned = bannedSubs.includes(subName.toLowerCase());

        // send request for sub data asynchronously
        let subPromise = getSubData(subName).then(async subData => {
            // extract the data of the stickied posts in that sub's data
            let stickiedPosts = [];
            
            // if the sub doesn't have data skip over it
            // this probably means the sub is private (i think)
            if (subData.data === undefined) {
                // actually let's check if the sub is banned and we
                // don't know about it
                if (!subRecordedAsBanned && subData.reason == "banned") {
                    // set the sub to be recorded as banned
                    console.log(subName + ": API displays as banned but not recorded as such. To be added to list");
                    bannedSubChanges.subsToAdd.push(subName);
                }
                return;
            }

            // if here, the sub appears *not* to be banned. check if it's on the
            // banned list. if so, set it to be removed.
            if (subRecordedAsBanned) {
                console.log(subName + ": API does not display as banned but recorded as such. To be removed from list");
                bannedSubChanges.subsToRemove.push(subName);
            }
            
            for (let post of subData.data.children) {
                let postData = post.data;
                if (postData.stickied) stickiedPosts.push(postData);
                else break; // if it's not stickied that means we've gone past the stickied posts
            }
            
            if (subAlreadyJohnOlivered) {
                // sub is already recorded as taking part in the john oliver protest.
                // just to be safe, if there is any change to its pinned posts
                // since last time, flag it for manual review
                
                console.log(subName + ": already johnolivered. checking if review required");
                
                let prevStickiedPosts = await getPrevStickiedPosts(subName);
                if (prevStickiedPosts != null && stickiedPosts.length == prevStickiedPosts.length) {
                    let allStickiedPostsMatch = true;
                    
                    for (let i = 0; i < stickiedPosts.length; i++) {
                        if (stickiedPosts[i].selftext != prevStickiedPosts[i]) {
                            allStickiedPostsMatch = false;
                            break;
                        }
                    }
                    
                    if (allStickiedPostsMatch) {
                        // all checks have passed - this sub doesn't need review
                        console.log(subName + ": checks passed, no review required");
                        return;
                    }
                }
                
                console.log(subName + ": one or more checks failed. flagging for manual review");
                
                // if we're here, we need to flag a manual review
                await createGithubRemovalIssue(subName);
                
                // save the stickied posts for next time
                await saveStickiedPosts(subName, stickiedPosts);
            } else {
                // sub is not recorded as being johnolivered
                
                // do any of the stickied posts contain the words john oliver?
                let containsJohnOliver = false;
                for (post of stickiedPosts) {
                    if (post.selftext.toLowerCase().includes("john oliver")) {
                        containsJohnOliver = true;
                        break;
                    }
                }
                
                if (containsJohnOliver) {
                    console.log(subName + ": matches john oliver filter. checking if review required");
                    
                    let prevStickiedPosts = await getPrevStickiedPosts(subName);
                    if (prevStickiedPosts != null && stickiedPosts.length == prevStickiedPosts.length) {
                        let allStickiedPostsMatch = true;
                        
                        for (let i = 0; i < stickiedPosts.length; i++) {
                            if (stickiedPosts[i].selftext != prevStickiedPosts[i]) {
                                allStickiedPostsMatch = false;
                                break;
                            }
                        }
                        
                        if (allStickiedPostsMatch) {
                            // all checks have passed - this sub doesn't need review
                            console.log(subName + ": no change, no review required");
                            return;
                        }
                    }
                    
                    console.log(subName + ": requires human check. flagging for manual review");
                    
                    // if we're here, we need to flag a manual review
                    await createGithubAdditionIssue(subName);
                    
                    // save the stickied posts for next time
                    await saveStickiedPosts(subName, stickiedPosts);
                }
            }
        });
        
        subPromises.push(subPromise);

        // pls dont hate me reddit api
        await wait(20);
    }

    await Promise.all(subPromises);

    // deal with banned sub changes
    console.log("Processing banned sub changes (if any)");
    await processBannedSubChanges(bannedSubs, bannedSubChanges);

    // we're done! (hopefully)
    console.log("** Function complete **");
}

main();
