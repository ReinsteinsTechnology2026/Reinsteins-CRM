import logo from "../../assets/logo.png";

function CompanyLogo({

  size = 60,

  className = ""

}) {

  return (

    <img

      src={logo}

      alt="Reinsteins Technology"

      width={size}

      height={size}

      className={className}

      draggable={false}

      style={{

        objectFit: "contain",

        display: "block",

        userSelect: "none"

      }}

    />

  );

}

export default CompanyLogo;