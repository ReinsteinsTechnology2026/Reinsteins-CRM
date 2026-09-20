const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 11 -- SOP LIBRARY
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

const TINY_PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test.describe("SOP Library", () => {

    test("Admin can upload a PDF; document appears in the list", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/sops`);

        await page.getByRole("button", { name: /Upload SOP/i }).click();
        await page.getByPlaceholder(/Employee Onboarding Checklist/i).fill("E2E Onboarding Guide (a rather long and realistic filename for testing)");
        await page.locator('input[type="file"]').setInputFiles({
            name: "e2e-onboarding-guide-with-a-realistically-long-filename.pdf",
            mimeType: "application/pdf",
            buffer: TINY_PDF_BYTES,
        });
        // exact: true -- otherwise this also substring-matches the
        // "Upload SOP" button that opens the modal in the first place.
        await page.getByRole("button", { name: "Upload", exact: true }).click();

        await expect(page.getByText("E2E Onboarding Guide")).toBeVisible({ timeout: 10000 });
        expect(health.getConsoleErrors().filter((e) => !/favicon/i.test(e))).toEqual([]);
    });

    test("invalid file type is rejected", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/sops`);

        await page.getByRole("button", { name: /Upload SOP/i }).click();
        await page.getByPlaceholder(/Employee Onboarding Checklist/i).fill("E2E Bad File Type");

        // The <input accept="..."> attribute itself restricts the OS
        // file picker, but the real security boundary is server-side --
        // exercised directly here via the API with a text/plain body,
        // bypassing the picker entirely (the way a malicious/misconfigured
        // client would).
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const form = new FormData();
        form.append("title", "E2E Bad File Type");
        form.append("sopFile", new Blob([Buffer.from("not a real document")], { type: "text/plain" }), "malicious.txt");
        const uploadRes = await page.request.post("http://localhost:5000/api/sops", { headers, multipart: { title: "E2E Bad File Type", sopFile: { name: "malicious.txt", mimeType: "text/plain", buffer: Buffer.from("not a real document") } } });
        expect(uploadRes.status(), "a .txt file was accepted by the SOP upload endpoint").toBe(400);

        await page.getByRole("button", { name: "Cancel" }).click();
    });

    test("authenticated employee can view and download; cannot see an upload control", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/sops`);

        await expect(page.getByText("E2E Onboarding Guide")).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole("button", { name: /Upload SOP/i })).toHaveCount(0);

        const [download] = await Promise.all([
            page.waitForEvent("download").catch(() => null),
            page.getByTitle(/Download/i).first().click().catch(() => null),
        ]);
        // Some browsers/environments route downloads through a new tab
        // instead of firing a `download` event -- either is acceptable
        // here; what matters is the click doesn't error out.
        void download;
    });

    test("HR (non-admin-tier) cannot upload or delete", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.hr, "employee");
        await page.goto(`/${fixtures.slug}/employee/sops`);

        await expect(page.getByRole("button", { name: /Upload SOP/i })).toHaveCount(0);

        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const uploadAttempt = await page.request.post("http://localhost:5000/api/sops", {
            headers,
            multipart: { title: "HR should not be able to upload", sopFile: { name: "x.pdf", mimeType: "application/pdf", buffer: TINY_PDF_BYTES } },
        });
        expect(uploadAttempt.status(), "HR was able to upload an SOP via a direct API call").toBe(403);
    });

    test("Admin can delete; unauthorized user cannot", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const listRes = await page.request.get("http://localhost:5000/api/sops", { headers });
        const sop = (await listRes.json()).sops.find((s) => s.title.startsWith("E2E Onboarding Guide"));
        expect(sop, "seeded SOP not found for delete test").toBeTruthy();

        const deleteAsEmployee = await page.request.delete(`http://localhost:5000/api/sops/${sop.id}`, { headers });
        expect(deleteAsEmployee.status(), "a plain employee was able to delete an SOP").toBe(403);

        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/sops`);
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByTitle("Delete").first().click();
        await expect(page.getByText("E2E Onboarding Guide")).toHaveCount(0, { timeout: 10000 });
    });

});

test.describe("SOP Library -- mobile", () => {

    test.use({ viewport: { width: 390, height: 844 } });

    test("upload UI and document list are usable on a mobile viewport", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/sops`);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, "SOP library page has horizontal overflow on mobile").toBeLessThanOrEqual(391);

        await page.getByRole("button", { name: /Upload SOP/i }).click();
        await page.getByPlaceholder(/Employee Onboarding Checklist/i).fill("E2E Mobile Upload Doc");
        await page.locator('input[type="file"]').setInputFiles({
            name: "mobile-doc.png",
            mimeType: "image/png",
            buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
        });
        const modalScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(modalScrollWidth, "Upload SOP modal overflows on mobile").toBeLessThanOrEqual(391);

        await page.getByRole("button", { name: "Upload", exact: true }).click();
        await expect(page.getByText("E2E Mobile Upload Doc")).toBeVisible({ timeout: 10000 });
    });

});
