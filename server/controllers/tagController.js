const { searchTags } = require("../services/tagService");

// ==========================================
// LIST / SEARCH TAGS (autocomplete)
// Global, reusable dictionary -- no project/task
// scoping. Response is name-only metadata: no task
// IDs, project IDs, counts, or creator information.
// ==========================================

const getTags = async (req, res) => {

    try {

        const tags = await searchTags(req.query.search);

        return res.json({
            success: true,
            tags,
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to load tags",
        });

    }

};

module.exports = {
    getTags,
};
