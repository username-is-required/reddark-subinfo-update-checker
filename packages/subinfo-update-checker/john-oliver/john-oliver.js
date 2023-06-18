const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const { Octokit } = require("@octokit/core");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const request = require("./requests.js");


const octokit = new Octokit({
    auth: process.env.GITHUB_ACCESS_TOKEN
});

const s3 = new S3({
    forcePathStyle: false,
    endpoint: "https://fra1.digitaloceanspaces.com",
    credentials: {
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET
    }
});


// helper function to wait for some time
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// helper function to read a file and return the data
async function getFileContents(path) {
    try {
        let fileHandle = fsPromises.open(path);
        let fileData = await fileHandle.readFile();
        
        return fileData.toString()
    } catch (err) {
        console.log("Error occurred when reading file " + path + ": " + err);
        console.log("Exiting process");
        process.exit(1);
    }
}

// helper function to convert a stream to a string
function streamToString(stream) {
    let chunks = [];
    
    return new Promise((resolve, reject) => {
        stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
        stream.on("error", err => reject(err));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
}

// helper function to get the contents of a file stored in the cloud
async function getCloudFileContents(path) {
    let params = {
        Bucket: process.env.SPACES_BUCKET,
        Key: path
    };

    let command = new GetObjectCommand(params);
    
    try {
        let response = await s3.send(command);
        let contents = await streamToString(response.Body);

        return contents;
    } catch (err) {
        console.log("Error occurred when reading file from Spaces - " + path + ": " + err);
        console.log("Exiting process");
        process.exit(1);
    }
}

// helper function to save a file with given name and contents to the cloud
async function saveCloudFile(path, contents) {
    let params = {
        Bucket: process.env.SPACES_BUCKET,
        Key: path,
        Body: contents
    };

    let command = new PutObjectCommand(params);

    try {
        s3.send(command);
    } catch (err) {
        console.log("Error occurred when writing file to Spaces - " + path + ": " + err);
        console.log("Exiting process");
        process.exit(1);
    }
}

async function fetchValidJsonData(url) {
    let data = await request.httpsGet(url);
    
    try {
        data = JSON.parse(data);
    } catch (err) {
        console.log(url + ": Request to Reddit errored (bad JSON) [will retry]");
        
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

async function createGithubAdditionIssue(subName, postLink) {
    let issueTemplatePath = path.join(__dirname, "template-issues", "potential-addition.md");
    let issueTemplate = await getFileContents(issueTemplatePath);
    
    let title = "🤖 possible new johnoliver sub: " + subName;
    let body = issueTemplate.replaceAll("%subname%", subName).replaceAll("%post-link%", postLink);
    
    await createGithubIssue(title, body);
}

async function createGithubRemovalIssue(subName, postLink) {
    let issueTemplatePath = path.join(__dirname, "template-issues", "potential-removal.md");
    let issueTemplate = await getFileContents(issueTemplatePath);
    
    let title = "🤖 possible johnoliver sub removal: " + subName;
    let body = issueTemplate.replaceAll("%subname%", subName).replaceAll("%post-link%", postLink);

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
        let subAlreadyJohnOlivered = johnOliverSubs.includes(subName);
        
        let subData = await getSubData(subName);
        
        // extract the data of the stickied posts in that sub's data
        let stickiedPosts = [];
        for (let post of subData.data.children) {
            let postData = post.data;
            if (postData.stickied) stickiedPosts.push(postData);
            else break; // if it's not stickied that means we've gone past the stickied posts
        }
        
        if (subAlreadyJohnOlivered) {
            // sub is already recorded as taking part in the john oliver protest.
            // just to be safe, if there is any change to its pinned posts
            // since last time, flag it for manual review
            
        } else {
            for (let post of [post1, post2]) {
                let postText = post.selftext.toLowerCase();
                let stickied = post.stickied;
                
                if (stickied && postText.includes("john oliver")) {
                    // potential johnolivered sub

                }
            }
        }
    }
}

exports.main = main;
