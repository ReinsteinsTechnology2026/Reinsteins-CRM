import api from "./api";

// ==========================================
// SEARCH / LIST TAGS (autocomplete)
// ==========================================

export const searchTags = async (query) => {

    const { data } = await api.get("/tags", {
        params: { search: query || "" }
    });

    return data;

};
