import { useState } from "react";

import { toast } from "react-toastify";

import { createOrganization } from "../../services/organizationsService";

import "./Organizations.css";

function CreateOrganizationModal({

    onClose,

    onCreated

}) {

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        name: "",
        description: "",
        status: "active",

    });

    function handleChange(event) {

        setFormData({

            ...formData,

            [event.target.name]: event.target.value,

        });

    }

    async function handleSubmit(event) {

        event.preventDefault();

        if (!formData.name.trim()) {
            toast.error("Organization name is required");
            return;
        }

        try {

            setLoading(true);

            await createOrganization(formData);

            toast.success("Organization created successfully");

            onCreated();

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to create organization");

        } finally {

            setLoading(false);

        }

    }

    return (

        <div className="org-modal-overlay">

            <div className="org-modal">

                <div className="org-modal-header">

                    <div>
                        <h2>Create Organization</h2>
                        <p>Organizations are the top-level container for members and projects.</p>
                    </div>

                    <button
                        type="button"
                        className="org-modal-close"
                        onClick={onClose}
                    >
                        &times;
                    </button>

                </div>

                <form onSubmit={handleSubmit} className="org-modal-form">

                    <div className="org-form-group">
                        <label>Organization Name *</label>
                        <input
                            type="text"
                            name="name"
                            placeholder="Example: ABC Technologies"
                            value={formData.name}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="org-form-group">
                        <label>Description</label>
                        <textarea
                            name="description"
                            rows={4}
                            placeholder="What is this organization about?"
                            value={formData.description}
                            onChange={handleChange}
                        />
                    </div>

                    <div className="org-form-group">
                        <label>Status</label>
                        <select
                            name="status"
                            value={formData.status}
                            onChange={handleChange}
                        >
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                        </select>
                    </div>

                    <div className="org-modal-footer">

                        <button
                            type="button"
                            className="org-secondary-button"
                            onClick={onClose}
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                            className="org-primary-button"
                            disabled={loading}
                        >
                            {loading ? "Creating..." : "Create Organization"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateOrganizationModal;
