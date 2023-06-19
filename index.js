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
    
    for (let i in stickiedPosts)
        data[FIRESTORE_FIELDS["STICKIED_" + (i+1)]] = stickiedPosts[i].selftext;

    await doc.set(data, { merge: false });
}

async function createGithubIssue(title, body) {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues', {
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
        await createGithubIssue(title, body);
    }
    
    // wait 5s after creating the issue
    // (trying to not be rate limited by github here)
    await wait(5000);
}

async function createGithubAdditionIssue(subName) {
    let issueTemplatePath = path.join(__dirname, "template-issues", "potential-addition.md");
    let issueTemplate = await getFileContents(issueTemplatePath);
    
    let title = "🤖 possible new johnoliver sub: " + subName;
    let body = issueTemplate.replaceAll("%subname%", subName);
    
    await createGithubIssue(title, body);
}

async function createGithubRemovalIssue(subName) {
    let issueTemplatePath = path.join(__dirname, "template-issues", "potential-removal.md");
    let issueTemplate = await getFileContents(issueTemplatePath);
    
    let title = "🤖 possible johnoliver sub removal: " + subName;
    let body = issueTemplate.replaceAll("%subname%", subName);

    await createGithubIssue(title, body);
}

async function main() {
    console.log("** Started function **");

    console.log("Getting list of participating subs");
    let subNames = await getParticipatingSubsList();

    console.log("Getting list of currently johnoliverified subs");
    let johnOliverSubs = await fetchValidJsonData("https://cdn.jsdelivr.net/gh/username-is-required/reddark-subinfo@main/john-oliver-subs.json");
    johnOliverSubs = johnOliverSubs.johnOliverSubs;
    
    console.log("Looping over participating subs");
    for (let subName of subNames) {
        // is the sub already part of the john oliver cult?
        let subAlreadyJohnOlivered = johnOliverSubs.includes(subName.toLowerCase());
        
        let subData = await getSubData(subName);
        
        // extract the data of the stickied posts in that sub's data
        let stickiedPosts = [];
        
        // some weird error happened here & i want to know which sub caused it
        if (subData.data === undefined) {
            console.log(subName + ": `data` property undefined");
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
                
                for (let i in stickiedPosts) {
                    if (stickiedPosts[i].selftext != prevStickiedPosts[i]) {
                        allStickiedPostsMatch = false;
                        break;
                    }
                }
                
                if (allStickiedPostsMatch) {
                    // all checks have passed - this sub doesn't need review
                    console.log(subName + ": checks passed, no review required");
                    continue;
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
                    
                    for (let i in stickiedPosts) {
                        if (stickiedPosts[i].selftext != prevStickiedPosts[i]) {
                            allStickiedPostsMatch = false;
                            break;
                        }
                    }
                    
                    if (allStickiedPostsMatch) {
                        // all checks have passed - this sub doesn't need review
                        console.log(subName + ": no change, no review required");
                        continue;
                    }
                }
                
                console.log(subName + ": requires human check. flagging for manual review");
                
                // if we're here, we need to flag a manual review
                await createGithubAdditionIssue(subName);
                
                // save the stickied posts for next time
                await saveStickiedPosts(subName, stickiedPosts);
            }
        }
        
        // wait before next request (pls dont hate me reddit)
        await wait(20);
    }

    // we're done! (hopefully)
    console.log("** Function complete **");
}

main();
