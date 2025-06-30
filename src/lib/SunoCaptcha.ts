import { Page, Locator, BrowserContext, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import pino from 'pino';
import yn from 'yn';

const logger = pino();

/**
 * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
 */
async function click(cursor: Cursor | undefined, ghostCursorEnabled: boolean, target: Locator | Page, position?: { x: number, y: number }): Promise<void> {
    if (ghostCursorEnabled && cursor) {
        let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
        if (position)
            pos = {
                ...pos,
                x: pos.x + position.x,
                y: pos.y + position.y,
                width: null,
                height: null,
            };
        return cursor.actions.click({
            target: pos
        });
    } else {
        if (isPage(target))
            return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
        else
            return target.click({ force: true, position });
    }
}

/**
 * Get the BrowserType from the `BROWSER` environment variable.
 * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
 */
function getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
        case 'firefox':
            return firefox;
        default:
            return chromium;
    }
}

/**
 * Launches a browser with the necessary cookies
 * @returns {BrowserContext}
 */
async function launchBrowser(userAgent: string, currentToken: string, cookies: Record<string, string | undefined>): Promise<BrowserContext> {
    const args = [
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=site-per-process',
        '--disable-features=IsolateOrigins',
        '--disable-extensions',
        '--disable-infobars'
    ];
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
        args.push('--enable-unsafe-swiftshader',
            '--disable-gpu',
            '--disable-setuid-sandbox');
    const browser = await getBrowserType().launch({
        args,
        headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    const context = await browser.newContext({ userAgent: userAgent, locale: process.env.BROWSER_LOCALE, viewport: null });
    const browserCookies = [];
    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    browserCookies.push({
        name: '__session',
        value: currentToken + '',
        domain: '.suno.com',
        path: '/',
        sameSite: lax
    });
    for (const key in cookies) {
        browserCookies.push({
            name: key,
            value: cookies[key] + '',
            domain: '.suno.com',
            path: '/',
            sameSite: lax
        })
    }
    await context.addCookies(browserCookies);
    return context;
}

/**
 * Checks for CAPTCHA verification and solves the CAPTCHA if needed
 * @returns {string|null} hCaptcha token. If no verification is required, returns null
 */
export async function getCaptchaToken(
    userAgent: string,
    currentToken: string,
    cookies: Record<string, string | undefined>,
    onNewToken: (token: string) => void
): Promise<string | null> {
    logger.info('CAPTCHA required. Launching browser...');
    const browser = await launchBrowser(userAgent, currentToken, cookies);
    const page = await browser.newPage();
    await page.goto('https://suno.com/create', { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 0 });

    logger.info('Waiting for Suno interface to load');
    await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 });

    const ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
    const cursor = ghostCursorEnabled ? await createCursor(page) : undefined;

    logger.info('Triggering the CAPTCHA');
    try {
        await page.getByLabel('Close').click({ timeout: 2000 });
    } catch (e) { }

    const textarea = page.locator('.custom-textarea');
    await click(cursor, ghostCursorEnabled, textarea);
    await textarea.pressSequentially('Lorem ipsum', { delay: 80 });

    const button = page.locator('button[aria-label="Create"]').locator('div.flex');
    click(cursor, ghostCursorEnabled, button);

    const solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
    const controller = new AbortController();
    new Promise<void>(async (resolve, reject) => {
        const frame = page.frameLocator('iframe[title*="hCaptcha"]');
        const challenge = frame.locator('.challenge-container');
        try {
            const fs = await import('fs/promises');
            const path = await import('path');
            let wait = true;
            while (true) {
                if (wait)
                    await waitForRequests(page, controller.signal);
                const drag = (await challenge.locator('.prompt-text').first().innerText()).toLowerCase().includes('drag');
                let captcha: any;
                for (let j = 0; j < 3; j++) {
                    try {
                        logger.info('Sending the CAPTCHA to 2Captcha');
                        const payload: paramsCoordinates = {
                            body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                            lang: process.env.BROWSER_LOCALE
                        };
                        if (drag) {
                            payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                            payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
                        }
                        captcha = await solver.coordinates(payload);
                        break;
                    } catch (err: any) {
                        logger.info(err.message);
                        if (j != 2)
                            logger.info('Retrying...');
                        else
                            throw err;
                    }
                }
                if (drag) {
                    const challengeBox = await challenge.boundingBox();
                    if (challengeBox == null)
                        throw new Error('.challenge-container boundingBox is null!');
                    if (captcha.data.length % 2) {
                        logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
                        solver.badReport(captcha.id);
                        wait = false;
                        continue;
                    }
                    for (let i = 0; i < captcha.data.length; i += 2) {
                        const data1 = captcha.data[i];
                        const data2 = captcha.data[i + 1];
                        await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
                        await page.mouse.down();
                        await sleep(1.1);
                        await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
                        await page.mouse.up();
                    }
                    wait = true;
                } else {
                    for (const data of captcha.data) {
                        await click(cursor, ghostCursorEnabled, challenge, { x: +data.x, y: +data.y });
                    };
                }
                click(cursor, ghostCursorEnabled, frame.locator('.button-submit')).catch(e => {
                    if (e.message.includes('viewport'))
                        click(cursor, ghostCursorEnabled, button);
                    else
                        throw e;
                });
            }
        } catch (e: any) {
            if (e.message.includes('been closed') || e.message == 'AbortError')
                resolve();
            else
                reject(e);
        }
    }).catch(e => {
        browser.browser()?.close();
        throw e;
    });
    return (new Promise((resolve, reject) => {
        page.route('**/api/generate/v2/**', async (route: any) => {
            try {
                logger.info('hCaptcha token received. Closing browser');
                route.abort();
                browser.browser()?.close();
                controller.abort();
                const request = route.request();
                const newAuthToken = request.headers().authorization.split('Bearer ').pop();
                if (newAuthToken) {
                    onNewToken(newAuthToken);
                }
                resolve(request.postDataJSON().token);
            } catch (err) {
                reject(err);
            }
        });
    }));
}
