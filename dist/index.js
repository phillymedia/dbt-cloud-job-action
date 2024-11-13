"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const core = __importStar(require("@actions/core"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const axios_retry_1 = __importDefault(require("axios-retry"));
const yaml_1 = __importDefault(require("yaml"));
(0, axios_retry_1.default)(axios_1.default, {
    retryDelay: (retryCount) => retryCount * 1000,
    retries: 3,
    shouldResetTimeout: true,
    onRetry: (_retryCount, _error, _requestConfig) => {
        console.error("Error in request. Retrying...");
    }
});
const run_status = {
    1: 'Queued',
    2: 'Starting',
    3: 'Running',
    10: 'Success',
    20: 'Error',
    30: 'Cancelled'
};
const dbt_cloud_api = axios_1.default.create({
    baseURL: `${core.getInput('dbt_cloud_url')}/api/v2/`,
    timeout: 5000,
    headers: {
        'Authorization': `Token ${core.getInput('dbt_cloud_token')}`,
        'Content-Type': 'application/json'
    }
});
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
const BOOL_OPTIONAL_KEYS = ['generate_docs_override'];
const INTEGER_OPTIONAL_KEYS = ['threads_override', 'timeout_seconds_override'];
const YAML_PARSE_OPTIONAL_KEYS = ['steps_override'];
const STRING_PARSE_OPTIONAL_KEYS = ['git_sha', 'git_branch', 'schema_override', 'dbt_version_override', 'target_name_override'];
async function runJob(account_id, job_id) {
    const cause = core.getInput('cause');
    const body = { cause };
    // Handle boolean inputs
    for (const key of BOOL_OPTIONAL_KEYS) {
        const input = core.getInput(key);
        if (input !== '') {
            body[key] = core.getBooleanInput(key);
        }
    }
    // Handle integer inputs
    for (const key of INTEGER_OPTIONAL_KEYS) {
        const input = core.getInput(key);
        if (input !== '') {
            body[key] = parseInt(input);
        }
    }
    // Handle YAML parse inputs
    for (const key of YAML_PARSE_OPTIONAL_KEYS) {
        const input = core.getInput(key);
        if (input !== '') {
            core.debug(input);
            try {
                let parsedInput = yaml_1.default.parse(input);
                if (typeof parsedInput === 'string') {
                    parsedInput = [parsedInput];
                }
                body[key] = parsedInput;
            }
            catch (e) {
                core.setFailed(`Could not interpret ${key} correctly. Pass valid YAML in a string.\n Example:\n  property: '["a string", "another string"]'`);
                throw e;
            }
        }
    }
    // Handle string inputs
    for (const key of STRING_PARSE_OPTIONAL_KEYS) {
        const input = core.getInput(key);
        if (input !== '') {
            body[key] = input;
        }
    }
    core.debug(`Run job body:\n${JSON.stringify(body, null, 2)}`);
    const res = await dbt_cloud_api.post(`/accounts/${account_id}/jobs/${job_id}/run/`, body);
    return res.data;
}
async function getJobRun(account_id, run_id) {
    try {
        const res = await dbt_cloud_api.get(`/accounts/${account_id}/runs/${run_id}/?include_related=["run_steps"]`);
        return res.data;
    }
    catch (e) {
        const errorMsg = e instanceof Error ? e.toString() : String(e);
        if (errorMsg.search("timeout of ") !== -1 && errorMsg.search(" exceeded") !== -1) {
            console.error("Error getting job information from dbt Cloud. " + errorMsg + ". The dbt Cloud API is taking too long to respond.");
        }
        else {
            console.error("Error getting job information from dbt Cloud. " + errorMsg);
        }
    }
    return undefined;
}
async function getArtifacts(account_id, run_id) {
    const res = await dbt_cloud_api.get(`/accounts/${account_id}/runs/${run_id}/artifacts/run_results.json`);
    const run_results = res.data;
    core.info('Saving artifacts in target directory');
    const dir = './target';
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
    fs.writeFileSync(`${dir}/run_results.json`, JSON.stringify(run_results));
}
async function executeAction() {
    const account_id = core.getInput('dbt_cloud_account_id');
    const job_id = core.getInput('dbt_cloud_job_id');
    const failure_on_error = core.getBooleanInput('failure_on_error');
    const jobRun = await runJob(account_id, job_id);
    const runId = jobRun.data.id;
    core.info(`Triggered job. ${jobRun.data.href}`);
    fs.appendFileSync(process.env.GITHUB_STATE, `dbtCloudRunID=${jobRun.data.id}${os.EOL}`, {
        encoding: 'utf8'
    });
    let res;
    while (true) {
        await sleep(parseInt(core.getInput('interval')) * 1000);
        res = await getJobRun(account_id, runId);
        if (!res) {
            continue;
        }
        const status = run_status[res.data.status];
        core.info(`Run: ${res.data.id} - ${status}`);
        if (core.getBooleanInput('wait_for_job')) {
            if (res.data.is_complete) {
                core.info(`job finished with '${status}'`);
                break;
            }
        }
        else {
            core.info("Not waiting for job to finish. Relevant run logs will be omitted.");
            break;
        }
    }
    if ((res === null || res === void 0 ? void 0 : res.data.is_error) && failure_on_error) {
        core.setFailed("The job failed with an error.");
    }
    if (res === null || res === void 0 ? void 0 : res.data.is_error) {
        core.info("Loading logs...");
        await sleep(5000);
        res = await getJobRun(account_id, runId);
        if (res === null || res === void 0 ? void 0 : res.data.run_steps) {
            for (const step of res.data.run_steps) {
                core.info("# " + step.name);
                core.info(step.logs);
                core.info("\n************\n");
            }
        }
    }
    if (core.getBooleanInput('get_artifacts')) {
        await getArtifacts(account_id, runId);
    }
    return {
        git_sha: (res === null || res === void 0 ? void 0 : res.data.git_sha) || '',
        run_id: runId
    };
}
async function cleanupAction() {
    const account_id = core.getInput('dbt_cloud_account_id');
    const run_id = process.env.STATE_dbtCloudRunID;
    if (!run_id)
        return;
    const res = await getJobRun(account_id, parseInt(run_id));
    if (res && !res.data.is_complete && core.getBooleanInput('wait_for_job')) {
        core.info('Cancelling job...');
        await dbt_cloud_api.post(`/accounts/${account_id}/runs/${run_id}/cancel/`);
    }
    else {
        core.info('Nothing to clean');
    }
}
async function main() {
    if (process.env.STATE_dbtCloudRunID === undefined) {
        try {
            const outputs = await executeAction();
            const git_sha = outputs.git_sha;
            const run_id = outputs.run_id;
            core.info(`dbt Cloud Job commit SHA is ${git_sha}`);
            core.setOutput('git_sha', git_sha);
            core.setOutput('run_id', run_id);
        }
        catch (e) {
            core.setFailed('There has been a problem with running your dbt cloud job:\n' + String(e));
            if (e instanceof Error) {
                core.debug(e.stack || '');
            }
        }
    }
    else {
        try {
            await cleanupAction();
        }
        catch (e) {
            core.error('There has been a problem with cleaning up your dbt cloud job:\n' + String(e));
            if (e instanceof Error) {
                core.debug(e.stack || '');
            }
        }
    }
}
main();
//# sourceMappingURL=index.js.map