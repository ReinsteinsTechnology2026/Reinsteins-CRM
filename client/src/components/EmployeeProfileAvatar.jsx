import {
  useEffect,
  useState,
} from "react";

import {
  useNavigate,
  useParams,
} from "react-router-dom";

import api from "../services/api";
import { API_ORIGIN } from "../config";

// ==========================================
// BACKEND URL
// ==========================================

const BACKEND_URL = API_ORIGIN;

function EmployeeProfileAvatar() {
  const navigate =
    useNavigate();

  // Company-aware tenant users are rendered under
  // "/:companySlug/employee/..." -- navigating to the unprefixed
  // "/employee/profile" would take them off that route tree entirely
  // (and onto the one EmployeeSidebar's own basePath fix just above
  // also had to account for). Reinsteins (no companySlug) keeps the
  // existing unprefixed path unchanged.
  const { companySlug } = useParams();
  const profilePath = companySlug ? `/${companySlug}/employee/profile` : "/employee/profile";

  const [
    profile,
    setProfile,
  ] = useState(null);

  const [
    loading,
    setLoading,
  ] = useState(true);

  // ==========================================
  // LOAD EMPLOYEE PROFILE
  // ==========================================

  useEffect(() => {
    const loadProfile =
      async () => {
        try {
          const response =
            await api.get(
              "/employees/profile/me"
            );

          setProfile(
            response.data
              .profile
          );

        } catch (error) {
          console.error(
            "Unable to load employee profile:",
            error
          );

        } finally {
          setLoading(
            false
          );
        }
      };

    loadProfile();
  }, []);

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

      // If photo is already a complete URL

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

      // Otherwise attach backend URL

      return `${BACKEND_URL}${profile.profile_photo}`;
    };

  const profilePhotoUrl =
    getProfilePhotoUrl();

  // ==========================================
  // EMPLOYEE INITIAL
  // ==========================================

  const initial =
    profile
      ?.full_name
      ?.charAt(0)
      .toUpperCase() ||
    "E";

  // ==========================================
  // LOADING
  // ==========================================

  if (loading) {
    return (
      <div
        className="employee-profile-avatar"
        title="Loading profile"
      >
        E
      </div>
    );
  }

  // ==========================================
  // AVATAR
  // ==========================================

  return (
    <div
      className="employee-profile-avatar"
      onClick={() =>
        navigate(
          profilePath
        )
      }
      title="View My Profile"
      role="button"
      tabIndex={0}
      onKeyDown={(
        event
      ) => {
        if (
          event.key ===
            "Enter" ||
          event.key ===
            " "
        ) {
          navigate(
            profilePath
          );
        }
      }}
      style={{
        cursor:
          "pointer",
        overflow:
          "hidden",
        flexShrink:
          0,
      }}
    >

      {profilePhotoUrl ? (

        <img
          src={
            profilePhotoUrl
          }
          alt="Employee Profile"
          onError={(
            event
          ) => {
            event.currentTarget.style.display =
              "none";
          }}
          style={{
            width:
              "100%",
            height:
              "100%",
            objectFit:
              "cover",
            borderRadius:
              "50%",
            display:
              "block",
          }}
        />

      ) : (

        initial

      )}

    </div>
  );
}

export default EmployeeProfileAvatar;