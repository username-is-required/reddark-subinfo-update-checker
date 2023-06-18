const { Octokit } = require("@octokit/core");
const request = require("./requests.js");

// helper function to wait for some time
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function main() {
    console.log("** Started function **");

    console.log("Getting list of participating subs");
    let subNames = await getParticipatingSubsList();

    console.log("Looping over participating subs");
    for (let subName of subNames) {
        let subData = await getSubData(subName);
        
        // extract the data of the first two posts in that sub's data
        // (if there are any, i believe they should be the - max - two stickied posts)
        let post1 = subData.data.children[0].data;
        let post2 = subData.data.children[1].data;
        
        for (let post of [post1, post2]) {
            let postText = post.selftext.toLowerCase();
            let stickied = post.stickied;

            if (stickied && postText.includes("john oliver")) {
                // potential johnolivered sub
                
            }
        }
    }
}

exports.main = main;
