import zioVentureLogo from "../../assets/zioventure-logo.jpg";

function ZioVentureLogo({

  size = 48,

  className = ""

}) {

  return (

    <img

      src={zioVentureLogo}

      alt="ZioVenture"

      width={size}

      height={size}

      className={className}

      draggable={false}

      style={{

        objectFit: "contain",

        display: "block",

        userSelect: "none",

        borderRadius: 12

      }}

    />

  );

}

export default ZioVentureLogo;
