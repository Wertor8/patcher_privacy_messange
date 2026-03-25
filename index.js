const config = require('./config.js');
const puppeteer = require("puppeteer");
const rimraf = require("rimraf");
const path = require("path");
const process = require("process");
const fs = require("fs");
const child_process = require('child_process');
const git = require("nodegit");
const libxmljs = require("libxmljs");

async function download(downloadDir) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: {
            width: 1920,
            height: 1080
        }
    });
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow', 
        downloadPath: downloadDir
    });

    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36");
    const url = 'https://apkcombo.com/en-sk/apk-downloader/?q=' + config.packageName;
    console.log("Navigating to " + url);
    await page.goto(url, {waitUntil: 'networkidle2'});
    
    const downloadButtonSelector = '.variant .is-success';
    console.log(`Waiting for initial download button with selector: ${downloadButtonSelector}`);
    await page.waitForSelector(downloadButtonSelector, { visible: true, timeout: 60000 });
    console.log("Initial download button found.");
    
    console.log("Clicking the initial download button...");
    await page.click(downloadButtonSelector);
    
    const finalDownloadSelector = '.download-btn';
    console.log(`Waiting for final download link/button with selector: ${finalDownloadSelector}`);
    await page.waitForSelector(finalDownloadSelector, { visible: true, timeout: 90000 });
    console.log("Final download link/button found.");

    const downloadLink = await page.$eval(finalDownloadSelector, el => el.href);
    console.log("Navigating to download link: " + downloadLink);
    await page.goto(downloadLink, {waitUntil: 'networkidle2'});

    console.log("Waiting for APK file to appear in download directory...");
    let apkDownloaded = false;
    const maxAttempts = 60; 
    const checkInterval = 1000; 

    for (let i = 0; i < maxAttempts; i++) {
        const files = fs.readdirSync(downloadDir);
        const apkFile = files.find(file => file.toLowerCase().endsWith('.apk'));
        if (apkFile) {
            console.log(`APK file found: ${apkFile}`);
            apkDownloaded = true;
            break;
        }
        // console.log(`APK file not found yet. Attempt ${i + 1}/${maxAttempts}. Waiting for ${checkInterval / 1000} seconds...`);
        await page.waitFor(checkInterval);
    }

    if (!apkDownloaded) {
        console.error("APK file was not downloaded within the expected time.");
    }

    await browser.close();
}

let cleanUp = function (downloadDir) {
    console.log("Clearing download directory...");
    rimraf.sync(downloadDir);
};

let renameFile = function (downloadDir) {
    const downloads = fs.readdirSync(downloadDir);
    if (downloads.length !== 1) {
        console.error(`Downloaded ${downloads.length} files. Expected 1.`);
        const tempApk = downloads.find(file => file.toLowerCase().endsWith('.apk'));
        if (tempApk) {
            console.log(`Found potential temporary APK: ${tempApk}`);
            fs.renameSync(path.join(downloadDir, tempApk), path.join(downloadDir, 'app.apk'));
            console.log("Renamed temporary APK to app.apk");
            return;
        }
        process.exit(1);
    }

    console.log("Renaming downloaded file");
    fs.renameSync(path.join(downloadDir, downloads[0]), path.join(downloadDir, 'app.apk'));
};

async function jadx(apkPath, targetDir) {
    console.log("Decompiling...");
    const isWindows = /^win/.test(process.platform);
    const jadxApp = path.resolve(__dirname, 'jadx', 'bin', 'jadx' + (isWindows ? ".bat" : ""));
    const jadxArgs = ['--no-debug-info', '-dr', targetDir, '-ds', path.join(targetDir, 'java'), apkPath];

    const decompileLog = fs.createWriteStream(path.resolve(__dirname, 'jadx.log'));

    await new Promise(resolve => {
        const proc = child_process.spawn(jadxApp, jadxArgs);
        proc.stderr.pipe(decompileLog);
        proc.stdout.pipe(decompileLog);
        proc.on('close', (code) => {
            if (code !== 0) {
                console.error(`JADX exited with code ${code}. Check jadx.log for details.`);
            } else {
                console.log("JADX decompilation finished successfully.");
            }
            resolve();
        });
        proc.on('error', (err) => {
            console.error("Error during JADX execution:", err);
            resolve();
        });
    });
    console.log("Decompiled!")
}

async function gitPush(targetFolder, version) {
    const repo = await git.Repository.open(targetFolder);
    const index = await repo.refreshIndex();
    const status = await repo.getStatus();

    if (status.length === 0) {
        return console.log("No changes detected.");
    }
    console.log("Found " + status.length + " changes in repository!");

    console.log("Adding files...");
    for (let e of status) {
        await index.addByPath(e.path());
    }

    index.write();
    const tree = await index.writeTree();

    const message = "Updated to version " + version;

    console.log("Committing...");
    const head = await repo.getHeadCommit();

    console.log("Head is: " + head);

    await repo.createCommit("HEAD",
        git.Signature.now(config.git.author.name, config.git.author.email),
        git.Signature.now(config.git.commiter.name, config.git.commiter.email),
        message, tree, head == null ? [] : [head]
    );

    console.log("Pushing to remote 'origin'.");
    const remote = await repo.getRemote("origin");
    try {
        await remote.push(["+refs/heads/master:refs/heads/master"], {
            callbacks: {
                credentials: function (url, userName) {
                    return git.Cred.userpassPlaintextNew(config.git.credentials.username, config.git.credentials.password)
                },
                transferProgress: function (progress) {
                    console.log(progress);
                }
            },
        });
    } catch (e) {
        console.error("Push failed!");
        console.error(e);
        throw e;
    }
}

async function extractVersion(targetFolder) {
    const manifestPath = path.resolve(targetFolder, 'AndroidManifest.xml');
    if (!fs.existsSync(manifestPath)) {
        console.error(`AndroidManifest.xml not found at ${manifestPath}. Cannot extract version.`);
        throw new Error("AndroidManifest.xml not found.");
    }
    const contents = fs.readFileSync(manifestPath);
    const doc = libxmljs.parseXml(contents.toString('utf-8'));
    const manifest = doc.get('//manifest');

    const versionCodeAttr = manifest.attr('versionCode');
    const versionNameAttr = manifest.attr('versionName');

    if (!versionCodeAttr || !versionNameAttr) {
        console.error("Could not find versionCode or versionName attributes in AndroidManifest.xml.");
        throw new Error("Version attributes not found.");
    }

    const versionCode = versionCodeAttr.value();
    const versionName = versionNameAttr.value();

    return [versionCode, `${versionCode} (${versionName})`];
}

async function gitReset(targetFolder) {
    try {
        const repo = await git.Repository.open(targetFolder);
        console.log("Resetting local changes in GIT repository.");
        const head = await repo.getHeadCommit();
        if (head) {
            console.log("Head commit: " + head.id() + " " + head.message());
            await repo.clean(git.Repository.CLEAN.FORCE | git.Repository.CLEAN.REMOVE_UNTRACKED); 
            await git.Reset.default(repo, head, '.'); 
        } else {
            console.log("Repository is empty. No HEAD commit to reset.");
        }
    } catch (e) {
        console.log("Cannot open repository at specified path or repository is invalid.");
        console.log(e.message);
        console.log("Creating new repository at", targetFolder);
        fs.mkdirSync(targetFolder, { recursive: true }); 
        const repo = await git.Repository.init(targetFolder, 0);
        if (config.git.repository) {
            try {
                await git.Remote.create(repo, "origin", config.git.repository);
                console.log("Remote 'origin' created with URL:", config.git.repository);
            } catch (remoteError) {
                console.error("Failed to create remote 'origin':", remoteError.message);
            }
        } else {
            console.warn("config.git.repository is not defined. Cannot set remote origin.");
        }
    }
}

let loadLocalVersion = function () {
    const versionFilePath = path.join(__dirname, config.versionFile);
    try {
        return fs.readFileSync(versionFilePath, 'utf-8');
    } catch (e) {
        console.log(`Version file not found at ${versionFilePath}. Assuming version 0.`);
        return '0'; 
    }
};

function saveLocalVersion(versionCode) {
    fs.writeFileSync(path.join(__dirname, config.versionFile), versionCode, 'utf-8');
}

(async () => {
    const downloadDir = path.resolve(__dirname, 'downloaded');

    await gitReset(config.targetFolder);
    await cleanUp(downloadDir);
    await download(downloadDir);
    await renameFile(downloadDir);
    await jadx(path.join(downloadDir, 'app.apk'), config.targetFolder);

    const [versionCode, version] = await extractVersion(config.targetFolder);
    const localVersionCode = loadLocalVersion(); 

    console.log("Last committed version (local): " + localVersionCode);
    console.log("Current version (decompiled): " + versionCode);

    if (parseInt(versionCode) > parseInt(localVersionCode)) {
        console.log("Newer version decompiled. Pushing to git.");
        try {
            await gitPush(config.targetFolder, version);
            await saveLocalVersion(versionCode); 
        } catch (e) {
            console.log("Since git push failed. Not marking version as pushed.");
            console.error("Git push error:", e);
        }
    } else {
        console.log("Current version is not newer than the last committed version. No push to git.");
    }

    console.log("All done!");
})();