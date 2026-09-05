import {
  useEffect,
  useRef,
  useState,
} from "react";
import api from "../../services/api";
import { API_ORIGIN } from "../../config";



import {
  FaUser,
  FaCamera,
  FaSave,
  FaPhone,
  FaEnvelope,
  FaIdBadge,
  FaMapMarkerAlt,
  FaBriefcase,
  FaBirthdayCake,
  FaPhoneAlt,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import "./EmployeeProfile.css";

function EmployeeProfile() {


  const fileInputRef =
    useRef(null);

  const storedUser =
    localStorage.getItem(
      "user"
    );

  const user =
    storedUser
      ? JSON.parse(
          storedUser
        )
      : null;

  // ==========================================
  // STATE
  // ==========================================

  const [
    profile,
    setProfile,
  ] = useState(null);

  const [
    formData,
    setFormData,
  ] = useState({
    fullName: "",
    email: "",
    phone: "",
    address: "",
    dateOfBirth: "",
    emergencyContact: "",
  });

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    uploadingPhoto,
    setUploadingPhoto,
  ] = useState(false);

  // ==========================================
  // BACKEND URL
  // ==========================================

  const BACKEND_URL = API_ORIGIN;

  // ==========================================
  // FORMAT DATE FOR INPUT
  // ==========================================

  const formatDateForInput = (
    date
  ) => {
    if (!date) {
      return "";
    }

    const parsedDate =
      new Date(date);

    if (
      Number.isNaN(
        parsedDate.getTime()
      )
    ) {
      return "";
    }

    const year =
      parsedDate.getFullYear();

    const month =
      String(
        parsedDate.getMonth() +
          1
      ).padStart(
        2,
        "0"
      );

    const day =
      String(
        parsedDate.getDate()
      ).padStart(
        2,
        "0"
      );

    return `${year}-${month}-${day}`;
  };

  // ==========================================
  // SET PROFILE DATA
  // ==========================================

  const updateProfileState = (
    profileData
  ) => {
    setProfile(
      profileData
    );

    setFormData({
      fullName:
        profileData
          ?.full_name ||
        "",

      email:
        profileData
          ?.email ||
        "",

      phone:
        profileData
          ?.phone ||
        "",

      address:
        profileData
          ?.address ||
        "",

      dateOfBirth:
        formatDateForInput(
          profileData
            ?.date_of_birth
        ),

      emergencyContact:
        profileData
          ?.emergency_contact ||
        "",
    });
  };

  // ==========================================
  // LOAD MY PROFILE
  // ==========================================

  const loadProfile =
    async () => {
      try {
        setLoading(
          true
        );

        const response =
          await api.get(
            "/employees/profile/me"
          );

        updateProfileState(
          response.data
            .profile
        );

      } catch (error) {
        console.error(
          "Load Profile Error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to load profile"
        );

      } finally {
        setLoading(
          false
        );
      }
    };

  useEffect(() => {
    loadProfile();
  }, []);

  // ==========================================
  // HANDLE INPUT CHANGE
  // ==========================================

  const handleChange = (
    event
  ) => {
    const {
      name,
      value,
    } =
      event.target;

    setFormData(
      (
        previous
      ) => ({
        ...previous,

        [name]:
          value,
      })
    );
  };

  // ==========================================
  // UPDATE PROFILE
  // ==========================================

  const handleSaveProfile =
    async (
      event
    ) => {
      event.preventDefault();

      if (
        !formData
          .fullName
          .trim()
      ) {
        toast.error(
          "Full name is required"
        );

        return;
      }

      if (
        formData.email &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          formData.email
        )
      ) {
        toast.error(
          "Please enter a valid email address"
        );

        return;
      }

      try {
        setSaving(
          true
        );

        const response =
          await api.put(
            "/employees/profile/me",
            {
              fullName:
                formData
                  .fullName,

              email:
                formData
                  .email,

              phone:
                formData
                  .phone,

              address:
                formData
                  .address,

              dateOfBirth:
                formData
                  .dateOfBirth,

              // Designation is intentionally never sent — it is not
              // an employee-editable field (see Designation input
              // below, which is disabled and reads straight from
              // `profile`, not `formData`). The backend also
              // independently ignores this field on this endpoint
              // regardless of what a request sends.

              emergencyContact:
                formData
                  .emergencyContact,
            }
          );

        updateProfileState(
          response.data
            .profile
        );

        // ====================================
        // UPDATE LOCAL STORAGE USER
        // ====================================

        if (user) {
          const updatedUser = {
            ...user,

            fullName:
              response.data
                .profile
                .full_name,

            email:
              response.data
                .profile
                .email,
          };

          localStorage.setItem(
            "user",
            JSON.stringify(
              updatedUser
            )
          );
        }

        toast.success(
          "Profile updated successfully"
        );

      } catch (error) {
        console.error(
          "Update Profile Error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to update profile"
        );

      } finally {
        setSaving(
          false
        );
      }
    };

  // ==========================================
  // OPEN PHOTO SELECTOR
  // ==========================================

  const handleSelectPhoto =
    () => {
      fileInputRef
        .current
        ?.click();
    };

  // ==========================================
  // UPLOAD PROFILE PHOTO
  // ==========================================

  const handlePhotoChange =
    async (
      event
    ) => {
      const file =
        event.target
          .files?.[0];

      if (!file) {
        return;
      }

      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
      ];

      if (
        !allowedTypes.includes(
          file.type
        )
      ) {
        toast.error(
          "Please select a JPG, PNG or WEBP image"
        );

        event.target.value =
          "";

        return;
      }

      const maximumSize =
        5 *
        1024 *
        1024;

      if (
        file.size >
        maximumSize
      ) {
        toast.error(
          "Profile photo must be smaller than 5 MB"
        );

        event.target.value =
          "";

        return;
      }

      try {
        setUploadingPhoto(
          true
        );

        const uploadData =
          new FormData();

        uploadData.append(
          "profilePhoto",
          file
        );

        const response =
          await api.post(
            "/employees/profile/photo",
            uploadData
          );

        updateProfileState(
          response.data
            .profile
        );

        toast.success(
          "Profile photo updated successfully"
        );

      } catch (error) {
        console.error(
          "Upload Profile Photo Error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to upload profile photo"
        );

      } finally {
        setUploadingPhoto(
          false
        );

        event.target.value =
          "";
      }
    };

  // ==========================================
  // PROFILE PHOTO URL
  // ==========================================

  const getProfilePhotoUrl =
    () => {
      if (
        !profile
          ?.profile_photo
      ) {
        return null;
      }

      if (
        profile
          .profile_photo
          .startsWith(
            "http"
          )
      ) {
        return profile
          .profile_photo;
      }

      return `${BACKEND_URL}${profile.profile_photo}`;
    };

  const profilePhotoUrl =
    getProfilePhotoUrl();

  // ==========================================
  // LOGOUT
  // ==========================================



  // ==========================================
  // LOADING
  // ==========================================

  if (loading) {
    return (
      <div className="profile-loading-screen">

        <div className="profile-loading-card">

          <div className="profile-loading-spinner">
          </div>

          <p>
            Loading your
            profile...
          </p>

        </div>

      </div>
    );
  }

return (
<>


        {/* ======================================
            PROFILE CONTENT
        ====================================== */}

       <div className="employee-page-content">

          {/* PROFILE PHOTO CARD */}

          <section className="profile-photo-card">

            <div className="profile-photo-wrapper">

              {profilePhotoUrl ? (

                <img
                  src={
                    profilePhotoUrl
                  }
                  alt="Employee profile"
                  className="profile-main-photo"
                />

              ) : (

                <div className="profile-main-placeholder">

                  {profile
                    ?.full_name
                    ?.charAt(0)
                    .toUpperCase() ||
                    "E"}

                </div>

              )}

              <button
                type="button"
                className="profile-camera-button"
                onClick={
                  handleSelectPhoto
                }
                disabled={
                  uploadingPhoto
                }
                title="Change profile photo"
              >
                <FaCamera />
              </button>

              <input
                ref={
                  fileInputRef
                }
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={
                  handlePhotoChange
                }
                hidden
              />

            </div>

            <h2>
              {profile
                ?.full_name}
            </h2>

            <p className="profile-designation">

              {profile
                ?.designation ||
                "Employee"}

            </p>

            <div className="profile-employee-badge">

              <FaIdBadge />

              <span>
                {profile
                  ?.employee_id}
              </span>

            </div>

            <button
              type="button"
              className="profile-photo-upload-button"
              onClick={
                handleSelectPhoto
              }
              disabled={
                uploadingPhoto
              }
            >
              <FaCamera />

              {uploadingPhoto
                ? "Uploading..."
                : profilePhotoUrl
                ? "Change Photo"
                : "Upload Photo"}
            </button>

            <span className="profile-photo-help">
              JPG, PNG or WEBP.
              Maximum 5 MB.
            </span>

          </section>

          {/* ==================================
              PROFILE FORM
          ================================== */}

          <section className="profile-details-card">

            <div className="profile-section-header">

              <h2>
                Profile Details
              </h2>

              <p>
                Update your personal
                information
              </p>

            </div>

            <form
              onSubmit={
                handleSaveProfile
              }
              className="profile-form"
            >

              <div className="profile-form-grid">

                {/* EMPLOYEE ID */}

                <div className="profile-form-group">

                  <label>
                    <FaIdBadge />
                    Employee ID
                  </label>

                  <input
                    type="text"
                    value={
                      profile
                        ?.employee_id ||
                      ""
                    }
                    disabled
                  />

                  <span className="profile-field-help">
                    Employee ID cannot
                    be changed.
                  </span>

                </div>

                {/* EMAIL - NOW EDITABLE */}

                <div className="profile-form-group">

                  <label>
                    <FaEnvelope />
                    Email Address
                  </label>

                  <input
                    type="email"
                    name="email"
                    value={
                      formData
                        .email
                    }
                    onChange={
                      handleChange
                    }
                    placeholder="Enter your email address"
                  />

                  <span className="profile-field-help">
                    Enter your active
                    email address.
                  </span>

                </div>

                {/* FULL NAME */}

                <div className="profile-form-group">

                  <label>
                    <FaUser />
                    Full Name
                  </label>

                  <input
                    type="text"
                    name="fullName"
                    value={
                      formData
                        .fullName
                    }
                    onChange={
                      handleChange
                    }
                    placeholder="Enter your full name"
                    required
                  />

                </div>

                {/* PHONE */}

                <div className="profile-form-group">

                  <label>
                    <FaPhone />
                    Phone Number
                  </label>

                  <input
                    type="tel"
                    name="phone"
                    value={
                      formData
                        .phone
                    }
                    onChange={
                      handleChange
                    }
                    placeholder="Enter your phone number"
                  />

                </div>

                {/* DESIGNATION - READ ONLY, ADMIN-MANAGED */}

                <div className="profile-form-group">

                  <label>
                    <FaBriefcase />
                    Designation
                  </label>

                  <input
                    type="text"
                    value={
                      profile
                        ?.designation ||
                      ""
                    }
                    disabled
                  />

                  <span className="profile-field-help">
                    Designation is
                    managed by the
                    administrator.
                  </span>

                </div>

                {/* DATE OF BIRTH */}

                <div className="profile-form-group">

                  <label>
                    <FaBirthdayCake />
                    Date of Birth
                  </label>

                  <input
                    type="date"
                    name="dateOfBirth"
                    value={
                      formData
                        .dateOfBirth
                    }
                    onChange={
                      handleChange
                    }
                  />

                </div>

                {/* EMERGENCY CONTACT */}

                <div className="profile-form-group">

                  <label>
                    <FaPhoneAlt />
                    Emergency Contact
                  </label>

                  <input
                    type="tel"
                    name="emergencyContact"
                    value={
                      formData
                        .emergencyContact
                    }
                    onChange={
                      handleChange
                    }
                    placeholder="Enter emergency contact"
                  />

                </div>

                {/* ACCOUNT STATUS */}

                <div className="profile-form-group">

                  <label>
                    <FaUser />
                    Account Status
                  </label>

                  <input
                    type="text"
                    value={
                      profile
                        ?.status ||
                      ""
                    }
                    disabled
                  />

                </div>

                {/* ADDRESS */}

                <div className="profile-form-group profile-address-group">

                  <label>
                    <FaMapMarkerAlt />
                    Address
                  </label>

                  <textarea
                    name="address"
                    value={
                      formData
                        .address
                    }
                    onChange={
                      handleChange
                    }
                    placeholder="Enter your complete address"
                    rows="4"
                  />

                </div>

              </div>

              <div className="profile-form-actions">

                <button
                  type="submit"
                  className="profile-save-button"
                  disabled={
                    saving
                  }
                >
                  <FaSave />

                  {saving
                    ? "Saving..."
                    : "Save Changes"}
                </button>

              </div>

            </form>

          </section>

        </div>

      </>

    
  );
}

export default EmployeeProfile;